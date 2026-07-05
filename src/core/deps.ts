import { execa } from "execa";

export interface DepStatus {
  ok: boolean;
  node: { ok: boolean; version: string; detail?: string };
  ffmpeg: { ok: boolean; version?: string; detail?: string };
  ffprobe: { ok: boolean; version?: string; detail?: string };
  apiKey: { ok: boolean; detail?: string };
  videotoolbox: { ok: boolean; detail?: string };
}

async function probeBinary(bin: string): Promise<{ ok: boolean; version?: string; detail?: string }> {
  try {
    const { stdout } = await execa(bin, ["-version"]);
    return { ok: true, version: stdout.split("\n")[0] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: `${bin} not working (${msg.split("\n")[0]}). Install with: brew install ffmpeg`,
    };
  }
}

export async function checkDependencies(): Promise<DepStatus> {
  const major = Number(process.versions.node.split(".")[0]);
  const node = {
    ok: major >= 20,
    version: process.versions.node,
    detail: major >= 20 ? undefined : `Node 20+ required, found ${process.versions.node}`,
  };

  const [ffmpeg, ffprobe] = await Promise.all([probeBinary("ffmpeg"), probeBinary("ffprobe")]);

  let videotoolbox: DepStatus["videotoolbox"] = { ok: false, detail: "ffmpeg unavailable" };
  if (ffmpeg.ok) {
    try {
      const { stdout } = await execa("ffmpeg", ["-hide_banner", "-encoders"]);
      const ok = stdout.includes("h264_videotoolbox") && stdout.includes("hevc_videotoolbox");
      videotoolbox = {
        ok,
        detail: ok ? undefined : "videotoolbox encoders missing — hardware encoding unavailable",
      };
    } catch {
      videotoolbox = { ok: false, detail: "could not list ffmpeg encoders" };
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
    ? { ok: true }
    : {
        ok: false,
        detail:
          "ANTHROPIC_API_KEY not set — vision analysis and cut proposal will fail. " +
          "Set it in the MCP server config env block.",
      };

  return {
    ok: node.ok && ffmpeg.ok && ffprobe.ok && videotoolbox.ok && apiKey.ok,
    node,
    ffmpeg,
    ffprobe,
    apiKey,
    videotoolbox,
  };
}

export function formatDepIssues(deps: DepStatus): string[] {
  const issues: string[] = [];
  for (const [name, status] of Object.entries(deps)) {
    if (name === "ok") continue;
    const s = status as { ok: boolean; detail?: string };
    if (!s.ok && s.detail) issues.push(`${name}: ${s.detail}`);
  }
  return issues;
}
