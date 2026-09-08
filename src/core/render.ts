import fs from "node:fs";
import path from "node:path";
import { UserError } from "./errors.js";
import { type Project, assertSourceMounted } from "./project.js";
import { openDb, getClip, type ClipRow } from "./graph.js";
import { execa } from "execa";
import { fileURLToPath } from "node:url";
import { runFfmpeg, runFfprobe, hasVideotoolbox } from "./ffmpeg.js";
import type { Timeline, TimelineClip, TextOverlay } from "../schemas/timeline.js";
import type { ProgressReporter } from "./progress.js";
import { mapConcurrent } from "./concurrency.js";

/** Concurrent intermediate encodes — M-series media engines handle several at once. */
const RENDER_CONCURRENCY = 4;

export type RenderMode = "preview" | "final";

export interface RenderResult {
  path: string;
  durationS: number;
  sizeBytes: number;
  mode: RenderMode;
  width: number;
  height: number;
}

const PREVIEW_HEIGHT = 720;
const FINAL_MAX_WIDTH = 3840;
const FINAL_MAX_HEIGHT = 2160;
// Text is rasterised to PNGs (see tools/make_text_png.py) because this ffmpeg
// is built without libfreetype — no drawtext/subtitles/ass filter exists.
const TEXT_PNG_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tools/make_text_png.py");

interface OutputFormat {
  width: number;
  height: number;
  fps: number;
}

function outputFormat(timeline: Timeline, mode: RenderMode): OutputFormat {
  const { width, height, fps } = timeline.output;
  if (mode === "preview") {
    const w = Math.round(((width / height) * PREVIEW_HEIGHT) / 2) * 2;
    return { width: w, height: PREVIEW_HEIGHT, fps };
  }
  const scale = Math.min(1, FINAL_MAX_WIDTH / width, FINAL_MAX_HEIGHT / height);
  return {
    width: Math.round((width * scale) / 2) * 2,
    height: Math.round((height * scale) / 2) * 2,
    fps,
  };
}

async function videoEncoderArgs(mode: RenderMode): Promise<string[]> {
  const vt = await hasVideotoolbox();
  if (mode === "preview") {
    return vt
      ? ["-c:v", "h264_videotoolbox", "-b:v", "8M"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"];
  }
  return vt
    ? ["-c:v", "hevc_videotoolbox", "-q:v", "60", "-tag:v", "hvc1"]
    : ["-c:v", "libx264", "-preset", "slow", "-crf", "18"];
}

function sourceFor(clip: ClipRow, mode: RenderMode): string {
  if (mode === "preview") {
    if (clip.proxy_path && fs.existsSync(clip.proxy_path)) return clip.proxy_path;
    if (fs.existsSync(clip.abs_path)) return clip.abs_path;
    throw new UserError(
      `Clip ${clip.clip_id} (${clip.rel_path}): proxy missing and drive not mounted — run skycut_scan_footage or reconnect the drive.`
    );
  }
  if (!fs.existsSync(clip.abs_path)) {
    throw new UserError(
      `Clip ${clip.clip_id} (${clip.rel_path}) not found on the source drive — reconnect it and retry. Final renders use originals.`
    );
  }
  return clip.abs_path;
}

async function probeDuration(file: string, logDir: string): Promise<number> {
  const { stdout } = await runFfprobe(
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    logDir
  );
  return Number(String(stdout).trim());
}

/** Trim + normalize one timeline clip into an intermediate (uniform res/fps/pixfmt, no audio). */
async function renderIntermediate(
  source: string,
  clip: TimelineClip,
  fmt: OutputFormat,
  encArgs: string[],
  outFile: string,
  logDir: string
): Promise<void> {
  const filters = [
    ...(clip.speed !== 1 ? [`setpts=PTS/${clip.speed}`] : []),
    `scale=${fmt.width}:${fmt.height}:force_original_aspect_ratio=decrease`,
    `pad=${fmt.width}:${fmt.height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${fmt.fps}`,
    "format=yuv420p",
  ].join(",");
  await runFfmpeg(
    [
      "-ss", String(clip.in_s),
      "-t", String(clip.out_s - clip.in_s),
      "-i", source,
      "-vf", filters,
      ...encArgs,
      "-an",
      outFile,
    ],
    logDir
  );
}

/** Escape a path for use inside a filtergraph (movie=...). */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/([[\],;])/g, "\\$1");
}

async function overlayChains(
  overlays: TextOverlay[],
  fmt: OutputFormat,
  workDir: string,
  inputLabel: string
): Promise<{ chains: string[]; outLabel: string }> {
  if (!overlays.length) return { chains: [], outLabel: inputLabel };
  const chains: string[] = [];
  let label = inputLabel;
  for (const [i, o] of overlays.entries()) {
    const png = path.join(workDir, `overlay_${i}.png`);
    await execa("python3", [
      TEXT_PNG_SCRIPT,
      png,
      String(fmt.width),
      String(fmt.height),
      o.position,
      o.size,
      o.text,
    ]);
    // Full-frame RGBA PNG, so compositing is a plain overlay at the origin.
    const src = `[ovlsrc${i}]`;
    const out = i === overlays.length - 1 ? "[vtext]" : `[vovl${i}]`;
    chains.push(`movie=${escapeFilterPath(png)}${src}`);
    chains.push(`${label}${src}overlay=0:0:enable='between(t,${o.t_in},${o.t_out})'${out}`);
    label = out;
  }
  return { chains, outLabel: label };
}

export async function renderTimeline(
  project: Project,
  timeline: Timeline,
  mode: RenderMode,
  onProgress?: ProgressReporter
): Promise<RenderResult> {
  if (mode === "final") assertSourceMounted(project);
  const db = openDb(project);
  const logDir = project.paths.logs;
  const fmt = outputFormat(timeline, mode);
  const encArgs = await videoEncoderArgs(mode);
  const workDir = path.join(project.paths.renders, `.tmp-${mode}-v${timeline.version}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1. Per-clip intermediates (trim, speed, normalize).
    // Progress: one step per intermediate + one for final assembly.
    const totalSteps = timeline.clips.length + 1;
    let prepared = 0;
    const inters = await mapConcurrent(timeline.clips, RENDER_CONCURRENCY, async (tClip, i) => {
      const row = getClip(db, tClip.clip_id);
      if (!row) throw new UserError(`clip_id '${tClip.clip_id}' not in footage database — re-run skycut_scan_footage.`);
      const file = path.join(workDir, `inter_${String(i).padStart(3, "0")}.mp4`);
      await renderIntermediate(sourceFor(row, mode), tClip, fmt, encArgs, file, logDir);
      const durationS = await probeDuration(file, logDir);
      onProgress?.(++prepared, totalSteps, `prepared shot ${i + 1}/${timeline.clips.length} (${tClip.label ?? tClip.id})`);
      return { file, durationS };
    });

    // 2. Fold intermediates into one stream: xfade where a transition is set, concat for hard cuts.
    const inputs: string[] = inters.flatMap((x) => ["-i", x.file]);
    const chains: string[] = [];
    let currentLabel = "[0:v]";
    let currentLen = inters[0].durationS;
    for (let i = 1; i < inters.length; i++) {
      const transition = timeline.clips[i - 1].transition_out;
      const outLabel = `[v${i}]`;
      if (transition) {
        const offset = Math.max(0, currentLen - transition.duration_s);
        chains.push(
          `${currentLabel}[${i}:v]xfade=transition=${transition.style}:duration=${transition.duration_s}:offset=${offset.toFixed(3)}${outLabel}`
        );
        currentLen = offset + inters[i].durationS;
      } else {
        chains.push(`${currentLabel}[${i}:v]concat=n=2:v=1:a=0${outLabel}`);
        currentLen += inters[i].durationS;
      }
      currentLabel = outLabel;
    }

    // 3. Text overlays on the assembled stream.
    const overlay = await overlayChains(timeline.text_overlays ?? [], fmt, workDir, currentLabel);
    chains.push(...overlay.chains);
    currentLabel = overlay.outLabel;
    // Single-clip, no-op graph still needs a named output.
    if (chains.length === 0) {
      chains.push(`${currentLabel}null[vout]`);
      currentLabel = "[vout]";
    }

    // 4. Optional music bed: loop to length, normalize to ~-18 LUFS, apply gain, fade out.
    const audioArgs: string[] = [];
    let musicInputIndex = -1;
    if (timeline.music) {
      if (!fs.existsSync(timeline.music.path)) {
        throw new UserError(`Music file not found: ${timeline.music.path}`);
      }
      musicInputIndex = inters.length;
      inputs.push("-stream_loop", "-1", "-i", timeline.music.path);
      const fadeStart = Math.max(0, currentLen - timeline.music.fade_out_s);
      chains.push(
        `[${musicInputIndex}:a]atrim=0:${currentLen.toFixed(3)},` +
          `loudnorm=I=-18:TP=-1.5:LRA=11,volume=${timeline.music.gain_db}dB,` +
          `afade=t=out:st=${fadeStart.toFixed(3)}:d=${timeline.music.fade_out_s}[aout]`
      );
      audioArgs.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
    }

    const outFile = path.join(
      project.paths.renders,
      `${timeline.project}-v${timeline.version}-${mode}.mp4`
    );
    onProgress?.(timeline.clips.length, totalSteps, `assembling ${timeline.clips.length} shots (${mode})`);
    await runFfmpeg(
      [
        ...inputs,
        "-filter_complex", chains.join(";"),
        "-map", currentLabel,
        ...audioArgs,
        ...encArgs,
        "-movflags", "+faststart",
        outFile,
      ],
      logDir
    );

    return {
      path: outFile,
      durationS: Math.round((await probeDuration(outFile, logDir)) * 100) / 100,
      sizeBytes: fs.statSync(outFile).size,
      mode,
      width: fmt.width,
      height: fmt.height,
    };
  } finally {
    db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
