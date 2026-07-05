import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initProject, type Project } from "./project.js";
import {
  computeDuration,
  validateTimeline,
  saveTimeline,
  loadTimeline,
  listVersions,
  applyEdit,
  summarizeTimeline,
  type ValidationContext,
} from "./timeline.js";
import type { Timeline } from "../schemas/timeline.js";

const ctx = (target?: number): ValidationContext => ({
  clipDurations: new Map([
    ["aaa111", 60],
    ["bbb222", 120],
  ]),
  targetDurationS: target,
});

const baseTimeline = (): Timeline => ({
  version: 1,
  project: "test",
  created: "2026-07-05T00:00:00Z",
  output: { width: 1920, height: 1080, fps: 30 },
  clips: [
    {
      id: "c1",
      clip_id: "aaa111",
      in_s: 0,
      out_s: 6,
      speed: 1,
      transition_out: { type: "xfade", style: "fade", duration_s: 0.75 },
    },
    { id: "c2", clip_id: "bbb222", in_s: 10, out_s: 16, speed: 1 },
  ],
});

describe("computeDuration", () => {
  it("sums clip lengths minus transition overlaps", () => {
    expect(computeDuration(baseTimeline())).toBe(11.25); // 6 + 6 - 0.75
  });
  it("respects speed", () => {
    const t = baseTimeline();
    t.clips[0].speed = 2;
    expect(computeDuration(t)).toBe(8.25); // 3 + 6 - 0.75
  });
  it("ignores transition_out on the last clip", () => {
    const t = baseTimeline();
    t.clips[1].transition_out = { type: "xfade", style: "fade", duration_s: 1 };
    expect(computeDuration(t)).toBe(11.25);
  });
});

describe("validateTimeline", () => {
  it("accepts a valid timeline", () => {
    expect(() => validateTimeline(baseTimeline(), ctx())).not.toThrow();
  });
  it("rejects out_s <= in_s", () => {
    const t = baseTimeline();
    t.clips[0].out_s = 0;
    expect(() => validateTimeline(t, ctx())).toThrow(/out_s/);
  });
  it("rejects unknown clip_id", () => {
    const t = baseTimeline();
    t.clips[0].clip_id = "ghost";
    expect(() => validateTimeline(t, ctx())).toThrow(/not found in the footage manifest/);
  });
  it("rejects out_s beyond source duration", () => {
    const t = baseTimeline();
    t.clips[0].out_s = 61;
    expect(() => validateTimeline(t, ctx())).toThrow(/exceeds source duration/);
  });
  it("rejects duration outside ±5% of target", () => {
    expect(() => validateTimeline(baseTimeline(), ctx(30))).toThrow(/outside ±5%/);
    expect(() => validateTimeline(baseTimeline(), ctx(11.3))).not.toThrow();
  });
  it("rejects duplicate timeline clip ids", () => {
    const t = baseTimeline();
    t.clips[1].id = "c1";
    expect(() => validateTimeline(t, ctx())).toThrow(/duplicate/);
  });
  it("rejects transitions longer than adjacent clips", () => {
    const t = baseTimeline();
    t.clips[0].transition_out = { type: "xfade", style: "fade", duration_s: 2.9 };
    t.clips[0].out_s = 2; // 2s clip with 2.9s transition
    expect(() => validateTimeline(t, ctx())).toThrow(/transition/);
  });
});

describe("versioning", () => {
  let home: string;
  let source: string;
  let project: Project;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "skycut-home-"));
    source = fs.mkdtempSync(path.join(os.tmpdir(), "skycut-src-"));
    process.env.SKYCUT_HOME = home;
    project = initProject(source, "TL Test");
  });
  afterEach(() => {
    delete process.env.SKYCUT_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  });

  it("saves sequential immutable versions and loads latest by default", () => {
    const { version: _v, ...body } = baseTimeline();
    const v1 = saveTimeline(project, body);
    const v2 = saveTimeline(project, { ...body, clips: body.clips.slice(0, 1) });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(listVersions(project)).toEqual([1, 2]);
    expect(loadTimeline(project).version).toBe(2);
    expect(loadTimeline(project, 1).clips).toHaveLength(2);
  });

  it("refuses to load a missing version", () => {
    expect(() => loadTimeline(project)).toThrow(/No timelines yet/);
  });
});

describe("applyEdit", () => {
  it("retrim", () => {
    const { result, summary } = applyEdit(baseTimeline(), { op: "retrim", id: "c2", out_s: 14 });
    expect(result.clips[1].out_s).toBe(14);
    expect(summary).toContain("retrimmed 'c2'");
  });
  it("remove + insert + reorder", () => {
    let t = baseTimeline();
    const removed = applyEdit(t, { op: "remove", id: "c1" });
    expect(removed.result.clips.map((c) => c.id)).toEqual(["c2"]);

    const inserted = applyEdit(t, {
      op: "insert",
      at_index: 0,
      clip: { id: "c0", clip_id: "bbb222", in_s: 0, out_s: 5, speed: 1 },
    });
    expect(inserted.result.clips.map((c) => c.id)).toEqual(["c0", "c1", "c2"]);

    const reordered = applyEdit({ ...inserted.result, version: 1 }, { op: "reorder", id: "c2", to_index: 0 });
    expect(reordered.result.clips.map((c) => c.id)).toEqual(["c2", "c0", "c1"]);
  });
  it("set_transition null → hard cut; set_music", () => {
    const t = baseTimeline();
    const cut = applyEdit(t, { op: "set_transition", id: "c1", transition: null });
    expect(cut.result.clips[0].transition_out).toBeUndefined();

    const withMusic = applyEdit(t, {
      op: "set_music",
      music: { path: "/tmp/bed.mp3", gain_db: -6, fade_out_s: 2 },
    });
    expect(withMusic.result.music?.path).toBe("/tmp/bed.mp3");
  });
  it("does not mutate the original and rejects unknown ids", () => {
    const t = baseTimeline();
    applyEdit(t, { op: "remove", id: "c1" });
    expect(t.clips).toHaveLength(2);
    expect(() => applyEdit(t, { op: "remove", id: "zz" })).toThrow(/No timeline clip/);
  });
});

describe("summarizeTimeline", () => {
  it("renders a shot list with durations and transitions", () => {
    const text = summarizeTimeline(baseTimeline());
    expect(text).toContain("2 shots");
    expect(text).toContain("11.3s");
    expect(text).toContain("fade 0.75s");
  });
});
