import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initProject, type Project } from "./project.js";
import { scanFootage, findVideoFiles, clipIdFor } from "./scan.js";
import { openDb, getClips } from "./graph.js";
import { makeTestClip } from "../test/fixtures.js";

let home: string;
let source: string;
let project: Project;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "skycut-home-"));
  source = fs.mkdtempSync(path.join(os.tmpdir(), "skycut-src-"));
  process.env.SKYCUT_HOME = home;

  await makeTestClip(source, "aerial-1.mp4", { durationS: 2 });
  await makeTestClip(path.join(source, "day2"), "lodge.MOV", { durationS: 3, pattern: "smptebars" });
  fs.writeFileSync(path.join(source, "._aerial-1.mp4"), "appledouble junk");
  fs.writeFileSync(path.join(source, "notes.txt"), "not a video");

  project = initProject(source, "Scan Test");
}, 60_000);

afterAll(() => {
  delete process.env.SKYCUT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(source, { recursive: true, force: true });
});

describe("findVideoFiles", () => {
  it("finds videos recursively, case-insensitive ext, skipping hidden/AppleDouble", () => {
    const files = findVideoFiles(source);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith("lodge.MOV"))).toBe(true);
    expect(files.some((f) => f.includes("._"))).toBe(false);
  });

  it("follows symlinks and skips broken ones", () => {
    const farm = fs.mkdtempSync(path.join(os.tmpdir(), "skycut-farm-"));
    try {
      fs.symlinkSync(path.join(source, "aerial-1.mp4"), path.join(farm, "linked.mp4"));
      fs.symlinkSync(path.join(source, "day2"), path.join(farm, "linked-dir"));
      fs.symlinkSync(path.join(source, "does-not-exist.mp4"), path.join(farm, "broken.mp4"));
      const files = findVideoFiles(farm);
      expect(files).toHaveLength(2); // linked.mp4 + day2/lodge.MOV via linked dir
      expect(files.some((f) => f.endsWith("broken.mp4"))).toBe(false);
    } finally {
      fs.rmSync(farm, { recursive: true, force: true });
    }
  });
});

describe("clipIdFor", () => {
  it("is stable and path/size dependent", () => {
    expect(clipIdFor("a.mp4", 100)).toBe(clipIdFor("a.mp4", 100));
    expect(clipIdFor("a.mp4", 100)).not.toBe(clipIdFor("a.mp4", 101));
    expect(clipIdFor("a.mp4", 100)).toHaveLength(12);
  });
});

describe("scanFootage", () => {
  it("probes clips, writes manifest + DB rows, builds proxies", async () => {
    const result = await scanFootage(project);
    expect(result.clipCount).toBe(2);
    expect(result.newClips).toBe(2);
    expect(result.proxiesBuilt).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.totalDurationS).toBeGreaterThan(4);

    const manifest = JSON.parse(fs.readFileSync(project.paths.manifest, "utf8"));
    expect(manifest.clips).toHaveLength(2);

    const db = openDb(project);
    const clips = getClips(db);
    db.close();
    expect(clips).toHaveLength(2);
    for (const clip of clips) {
      expect(clip.width).toBe(640);
      expect(clip.fps).toBe(30);
      expect(clip.proxy_path && fs.existsSync(clip.proxy_path)).toBe(true);
    }
  }, 120_000);

  it("is idempotent — re-scan skips existing proxies and adds nothing", async () => {
    const progress: Array<[number, number, string]> = [];
    const result = await scanFootage(project, (p, t, m) => progress.push([p, t, m]));
    expect(result.clipCount).toBe(2);
    expect(result.newClips).toBe(0);
    expect(result.proxiesBuilt).toBe(0);
    expect(result.proxiesSkipped).toBe(2);

    // progress: one tick per file + the manifest step, monotonically increasing
    expect(progress).toHaveLength(3);
    expect(progress[0][2]).toContain("scanned");
    expect(progress.at(-1)).toEqual([2, 2, "writing manifest"]);
    expect(progress.every(([p, t]) => p <= t)).toBe(true);
  }, 60_000);

  it("logs ffmpeg commands", () => {
    const log = fs.readFileSync(path.join(project.paths.logs, "ffmpeg.log"), "utf8");
    expect(log).toContain("ffprobe");
    expect(log).toContain("ffmpeg");
  });
});
