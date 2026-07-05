import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "./ffmpeg.js";
import type { Project } from "./project.js";
import type { ClipRow } from "./graph.js";

export const FRAME_INTERVAL_S = 4;

export interface SampledFrame {
  path: string;
  t: number;
}

/**
 * Sample keyframes every FRAME_INTERVAL_S into frames/<clip_id>/.
 * Prefers the proxy (works with the drive unplugged); falls back to the original.
 * Idempotent: returns existing frames if already sampled.
 */
export async function sampleFrames(project: Project, clip: ClipRow): Promise<SampledFrame[]> {
  const outDir = path.join(project.paths.frames, clip.clip_id);
  const existing = listFrames(outDir);
  if (existing.length > 0) return existing;

  const input =
    clip.proxy_path && fs.existsSync(clip.proxy_path)
      ? clip.proxy_path
      : fs.existsSync(clip.abs_path)
        ? clip.abs_path
        : null;
  if (!input) {
    throw new Error(
      `No readable source for clip ${clip.clip_id} (${clip.rel_path}) — proxy missing and drive not mounted.`
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  await runFfmpeg(
    [
      "-i",
      input,
      "-vf",
      `fps=1/${FRAME_INTERVAL_S},scale=768:-2`,
      "-qscale:v",
      "3",
      path.join(outDir, "%04d.jpg"),
    ],
    project.paths.logs
  );
  return listFrames(outDir);
}

function listFrames(dir: string): SampledFrame[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => ({
      path: path.join(dir, f),
      // ffmpeg fps=1/N emits frame 0001 at t=0, 0002 at t=N, ...
      t: (parseInt(f.replace(".jpg", ""), 10) - 1) * FRAME_INTERVAL_S,
    }));
}

export function countExistingFrames(project: Project, clipId: string): number {
  return listFrames(path.join(project.paths.frames, clipId)).length;
}

/** Frames a clip will need (for cost estimation before sampling). */
export function estimateFrameCount(durationS: number): number {
  return Math.max(1, Math.floor(durationS / FRAME_INTERVAL_S) + 1);
}
