import fs from "node:fs";
import path from "node:path";
import { execa, type Result } from "execa";
import { UserError } from "./errors.js";

/** Append every ffmpeg/ffprobe invocation to the project log for debuggability. */
function logCommand(logDir: string | undefined, bin: string, args: string[], exitCode: number | undefined): void {
  if (!logDir) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const line = `${new Date().toISOString()} [exit ${exitCode ?? "?"}] ${bin} ${args
      .map((a) => (/[ "]/.test(a) ? JSON.stringify(a) : a))
      .join(" ")}\n`;
    fs.appendFileSync(path.join(logDir, "ffmpeg.log"), line);
  } catch {
    /* logging must never break the pipeline */
  }
}

async function run(bin: string, args: string[], logDir?: string): Promise<Result> {
  try {
    const result = await execa(bin, args);
    logCommand(logDir, bin, args, result.exitCode);
    return result;
  } catch (err: unknown) {
    const e = err as { exitCode?: number; stderr?: string; message?: string };
    logCommand(logDir, bin, args, e.exitCode);
    const stderrTail = (e.stderr ?? "").split("\n").slice(-6).join("\n");
    throw new UserError(`${bin} failed (exit ${e.exitCode ?? "?"}):\n${stderrTail || e.message}`);
  }
}

export const runFfmpeg = (args: string[], logDir?: string) => run("ffmpeg", ["-hide_banner", "-y", ...args], logDir);
export const runFfprobe = (args: string[], logDir?: string) => run("ffprobe", args, logDir);

export interface ClipProbe {
  durationS: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrate: number | null;
  createdTime: string | null;
  gps: string | null;
}

function parseFps(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!num) return 0;
  return den ? Math.round((num / den) * 1000) / 1000 : num;
}

export async function probeClip(file: string, logDir?: string): Promise<ClipProbe> {
  const { stdout } = await runFfprobe(
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    logDir
  );
  const data = JSON.parse(stdout as string) as {
    format?: { duration?: string; bit_rate?: string; tags?: Record<string, string> };
    streams?: Array<Record<string, unknown>>;
  };
  const video = (data.streams ?? []).find((s) => s.codec_type === "video");
  if (!video) throw new UserError(`No video stream in ${file}`);

  const tags = data.format?.tags ?? {};
  const gps =
    tags["location"] ??
    tags["com.apple.quicktime.location.ISO6709"] ??
    tags["location-eng"] ??
    null;

  return {
    durationS: Number(data.format?.duration ?? 0),
    width: Number(video.width ?? 0),
    height: Number(video.height ?? 0),
    fps: parseFps(video.avg_frame_rate as string | undefined),
    codec: String(video.codec_name ?? "unknown"),
    bitrate: data.format?.bit_rate ? Number(data.format.bit_rate) : null,
    createdTime: tags["creation_time"] ?? null,
    gps,
  };
}

let videotoolboxAvailable: boolean | null = null;

export async function hasVideotoolbox(): Promise<boolean> {
  if (videotoolboxAvailable === null) {
    try {
      const { stdout } = await execa("ffmpeg", ["-hide_banner", "-encoders"]);
      videotoolboxAvailable = (stdout as string).includes("h264_videotoolbox");
    } catch {
      videotoolboxAvailable = false;
    }
  }
  return videotoolboxAvailable;
}

/** h264 encoder args: videotoolbox on Apple Silicon, libx264 fallback (logged) elsewhere. */
export async function h264EncoderArgs(bitrate: string): Promise<string[]> {
  return (await hasVideotoolbox())
    ? ["-c:v", "h264_videotoolbox", "-b:v", bitrate]
    : ["-c:v", "libx264", "-preset", "fast", "-b:v", bitrate];
}
