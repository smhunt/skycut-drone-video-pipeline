import path from "node:path";
import fs from "node:fs";
import { execa } from "execa";

/** Generate a tiny synthetic test clip with ffmpeg testsrc (libx264 for portability). */
export async function makeTestClip(
  dir: string,
  name: string,
  opts: { durationS?: number; size?: string; pattern?: string } = {}
): Promise<string> {
  const { durationS = 2, size = "640x360", pattern = "testsrc" } = opts;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  await execa("ffmpeg", [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `${pattern}=duration=${durationS}:size=${size}:rate=30`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  return file;
}
