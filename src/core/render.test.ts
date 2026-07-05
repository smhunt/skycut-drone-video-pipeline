import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import { initProject, type Project } from "./project.js";
import { scanFootage } from "./scan.js";
import { openDb, getClips } from "./graph.js";
import { saveTimeline } from "./timeline.js";
import { renderTimeline } from "./render.js";
import { makeTestClip } from "../test/fixtures.js";
import type { Timeline } from "../schemas/timeline.js";

let home: string;
let source: string;
let project: Project;
let timeline: Timeline;
let musicPath: string;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "skycut-home-"));
  source = fs.mkdtempSync(path.join(os.tmpdir(), "skycut-src-"));
  process.env.SKYCUT_HOME = home;

  await makeTestClip(source, "one.mp4", { durationS: 4, pattern: "testsrc" });
  await makeTestClip(source, "two.mp4", { durationS: 4, pattern: "smptebars" });
  await makeTestClip(source, "three.mp4", { durationS: 4, pattern: "testsrc2" });

  musicPath = path.join(source, "..", `skycut-music-${path.basename(source)}.wav`);
  await execa("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", musicPath]);

  project = initProject(source, "Render Test");
  await scanFootage(project);

  const db = openDb(project);
  const clips = getClips(db);
  db.close();
  const byName = (n: string) => clips.find((c) => c.rel_path === n)!;

  timeline = saveTimeline(project, {
    project: "render-test",
    created: new Date().toISOString(),
    output: { width: 1920, height: 1080, fps: 30 },
    music: { path: musicPath, gain_db: -6, fade_out_s: 1 },
    clips: [
      {
        id: "c1",
        clip_id: byName("one.mp4").clip_id,
        in_s: 0.5,
        out_s: 2.5,
        speed: 1,
        transition_out: { type: "xfade", style: "fade", duration_s: 0.5 },
        label: "opening",
      },
      { id: "c2", clip_id: byName("two.mp4").clip_id, in_s: 0, out_s: 2, speed: 1 }, // hard cut out
      { id: "c3", clip_id: byName("three.mp4").clip_id, in_s: 0, out_s: 3, speed: 1.5 },
    ],
    text_overlays: [{ text: "Render Test", t_in: 0.5, t_out: 2.0, position: "lower-third", size: "large" }],
  });
}, 120_000);

afterAll(() => {
  delete process.env.SKYCUT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(musicPath, { force: true });
});

async function probe(file: string) {
  const { stdout } = await execa("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
  ]);
  return JSON.parse(stdout) as {
    format: { duration: string };
    streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>;
  };
}

describe("renderTimeline preview", () => {
  it("renders a multi-clip xfade+concat cut with music at 720p", async () => {
    const result = await renderTimeline(project, timeline, "preview");
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);

    // expected: 2 + 2 - 0.5(xfade) + 2(3s @1.5x) = 5.5s
    expect(result.durationS).toBeGreaterThan(4.9);
    expect(result.durationS).toBeLessThan(6.1);

    const info = await probe(result.path);
    const video = info.streams.find((s) => s.codec_type === "video");
    const audio = info.streams.find((s) => s.codec_type === "audio");
    expect(video?.width).toBe(1280);
    expect(audio?.codec_name).toBe("aac");

    // temp intermediates cleaned up
    expect(fs.readdirSync(project.paths.renders).filter((f) => f.startsWith(".tmp"))).toHaveLength(0);
  }, 120_000);
});

describe("renderTimeline final", () => {
  it("renders from originals at full output size", async () => {
    const result = await renderTimeline(project, timeline, "final");
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    const info = await probe(result.path);
    const video = info.streams.find((s) => s.codec_type === "video");
    expect(["hevc", "h264"]).toContain(video?.codec_name); // hevc on Apple Silicon, x264 fallback elsewhere
  }, 180_000);

  it("caps final output at 4K", async () => {
    const big = saveTimeline(project, {
      ...timeline,
      output: { width: 7680, height: 4320, fps: 30 },
      music: undefined,
      text_overlays: undefined,
      clips: [timeline.clips[1]],
    } as Omit<Timeline, "version">);
    const result = await renderTimeline(project, big, "final");
    expect(result.width).toBe(3840);
    expect(result.height).toBe(2160);
  }, 180_000);
});
