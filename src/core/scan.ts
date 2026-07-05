import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { type Project, assertSourceMounted } from "./project.js";
import { probeClip, runFfmpeg, h264EncoderArgs } from "./ffmpeg.js";
import { openDb, upsertClip, getClips, type ClipRow } from "./graph.js";
import type { ProgressReporter } from "./progress.js";
import { mapConcurrent } from "./concurrency.js";

/** Concurrent ffmpeg workers — M-series media engines handle several encodes at once. */
const SCAN_CONCURRENCY = 4;

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mts", ".mkv"]);

export function findVideoFiles(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subdir — skip, don't crash the scan
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("._")) continue;
      const full = path.join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // Follow symlinks (curated source folders may link to files on other drives).
        try {
          const stat = fs.statSync(full);
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue; // broken link — skip
        }
      }
      if (isDirectory) walk(full);
      else if (isFile && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(full);
      }
    }
  };
  walk(root);
  return results.sort();
}

export function clipIdFor(relPath: string, sizeBytes: number): string {
  return crypto.createHash("sha1").update(`${relPath}:${sizeBytes}`).digest("hex").slice(0, 12);
}

export interface ScanResult {
  clipCount: number;
  totalDurationS: number;
  newClips: number;
  proxiesBuilt: number;
  proxiesSkipped: number;
  errors: string[];
}

export async function scanFootage(project: Project, onProgress?: ProgressReporter): Promise<ScanResult> {
  assertSourceMounted(project);
  const db = openDb(project);
  const logDir = project.paths.logs;
  const errors: string[] = [];
  let newClips = 0;
  let proxiesBuilt = 0;
  let proxiesSkipped = 0;

  try {
    const files = findVideoFiles(project.meta.sourcePath);
    const known = new Map(getClips(db).map((c) => [c.clip_id, c]));
    let completed = 0;

    await mapConcurrent(files, SCAN_CONCURRENCY, async (absPath) => {
      const relPath = path.relative(project.meta.sourcePath, absPath);
      const sizeBytes = fs.statSync(absPath).size;
      const clipId = clipIdFor(relPath, sizeBytes);
      const proxyPath = path.join(project.paths.proxies, `${clipId}.mp4`);

      if (!known.has(clipId)) {
        try {
          const probe = await probeClip(absPath, logDir);
          upsertClip(db, {
            clip_id: clipId,
            rel_path: relPath,
            abs_path: absPath,
            size_bytes: sizeBytes,
            duration_s: probe.durationS,
            width: probe.width,
            height: probe.height,
            fps: probe.fps,
            codec: probe.codec,
            bitrate: probe.bitrate,
            created_time: probe.createdTime,
            gps: probe.gps,
            proxy_path: null,
          });
          newClips++;
        } catch (err) {
          errors.push(`${relPath}: ${err instanceof Error ? err.message : String(err)}`);
          onProgress?.(++completed, files.length, `failed ${relPath}`);
          return;
        }
      } else {
        // Path may have changed (drive remount) — keep abs_path fresh.
        upsertClip(db, { ...known.get(clipId)!, abs_path: absPath, proxy_path: null });
      }

      if (fs.existsSync(proxyPath)) {
        proxiesSkipped++;
      } else {
        // Encode to a temp name, then rename: a killed run never leaves a truncated
        // proxy that a re-scan would mistake for complete.
        const tmpPath = path.join(project.paths.proxies, `.tmp-${clipId}.mp4`);
        try {
          const enc = await h264EncoderArgs("5M");
          await runFfmpeg(
            ["-i", absPath, "-vf", "scale=-2:'min(720,ih)'", ...enc, "-an", "-movflags", "+faststart", tmpPath],
            logDir
          );
          fs.renameSync(tmpPath, proxyPath);
          proxiesBuilt++;
        } catch (err) {
          fs.rmSync(tmpPath, { force: true });
          errors.push(`proxy ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
          onProgress?.(++completed, files.length, `failed proxy ${relPath}`);
          return;
        }
      }
      db.prepare("UPDATE clips SET proxy_path = ? WHERE clip_id = ?").run(proxyPath, clipId);
      onProgress?.(++completed, files.length, `scanned ${relPath}`);
    });

    // Sweep any temp files from previously killed runs.
    for (const leftover of fs.readdirSync(project.paths.proxies).filter((f) => f.startsWith(".tmp-"))) {
      fs.rmSync(path.join(project.paths.proxies, leftover), { force: true });
    }

    onProgress?.(files.length, files.length, "writing manifest");
    const clips = getClips(db);
    writeManifest(project, clips);
    return {
      clipCount: clips.length,
      totalDurationS: Math.round(clips.reduce((sum, c) => sum + c.duration_s, 0) * 10) / 10,
      newClips,
      proxiesBuilt,
      proxiesSkipped,
      errors,
    };
  } finally {
    db.close();
  }
}

function writeManifest(project: Project, clips: ClipRow[]): void {
  const manifest = {
    project: project.meta.slug,
    sourcePath: project.meta.sourcePath,
    scanned: new Date().toISOString(),
    clips: clips.map((c) => ({
      clip_id: c.clip_id,
      rel_path: c.rel_path,
      duration_s: c.duration_s,
      width: c.width,
      height: c.height,
      fps: c.fps,
      codec: c.codec,
      size_bytes: c.size_bytes,
      created_time: c.created_time,
      gps: c.gps,
      proxy: c.proxy_path ? path.basename(c.proxy_path) : null,
    })),
  };
  fs.writeFileSync(project.paths.manifest, JSON.stringify(manifest, null, 2));
}
