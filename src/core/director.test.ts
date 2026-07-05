import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Project } from "./project.js";
import { proposeCut, buildFootageGraph, type DirectorClient } from "./director.js";
import { loadTimeline, computeDuration } from "./timeline.js";
import { createSyntheticProject, destroySyntheticProject } from "../test/synthetic.js";

let fixture: { project: Project; home: string; source: string };

beforeAll(() => {
  fixture = createSyntheticProject();
});
afterAll(() => destroySyntheticProject(fixture));

/** A hand-built valid 30s answer using synthetic clip_ids: 4×8s - 3×0.75s xfade = 29.75s. */
const validTimelineJson = () =>
  JSON.stringify({
    project: "synthetic-lodge",
    created: "2026-07-05T00:00:00Z",
    output: { width: 3840, height: 2160, fps: 29.97 },
    clips: [
      { id: "c1", clip_id: "aerial01", in_s: 42, out_s: 50, speed: 1, transition_out: { type: "xfade", style: "fade", duration_s: 0.75 }, label: "approach over water" },
      { id: "c2", clip_id: "lodge02", in_s: 32, out_s: 40, speed: 1, transition_out: { type: "xfade", style: "fade", duration_s: 0.75 }, label: "lodge reveal" },
      { id: "c3", clip_id: "plane04", in_s: 2, out_s: 10, speed: 1, transition_out: { type: "xfade", style: "fade", duration_s: 0.75 }, label: "floatplane orbit" },
      { id: "c4", clip_id: "sunset05", in_s: 5, out_s: 13, speed: 1, label: "sunset pull-back" },
    ],
    text_overlays: [],
  });

describe("buildFootageGraph", () => {
  it("returns segments sorted by aesthetic with clip durations and a capped output format", () => {
    const graph = buildFootageGraph(fixture.project);
    expect(graph.segments).toHaveLength(12);
    expect(graph.segments[0].aesthetic).toBe(9.4);
    expect(graph.segments[0].clip_duration_s).toBe(80);
    expect(graph.output).toEqual({ width: 3840, height: 2160, fps: 29.97 });
  });
});

describe("proposeCut", () => {
  it("saves a validated timeline from the director's JSON (fences stripped, version server-owned)", async () => {
    const director: DirectorClient = {
      async complete() {
        return "```json\n" + validTimelineJson() + "\n```";
      },
    };
    const { timeline, attempts } = await proposeCut(fixture.project, director, {
      brief: "30 second lodge teaser, cinematic",
      duration_s: 30,
    });
    expect(attempts).toBe(1);
    expect(timeline.version).toBe(1);
    expect(computeDuration(timeline)).toBeCloseTo(29.75, 1);
    expect(loadTimeline(fixture.project, 1).clips).toHaveLength(4);
  });

  it("retries once with validation errors, then succeeds", async () => {
    const prompts: string[] = [];
    const director: DirectorClient = {
      async complete(_system, user) {
        prompts.push(user);
        if (prompts.length === 1) {
          // invalid: bogus clip_id and way off target
          return JSON.stringify({
            project: "x",
            created: "2026-07-05T00:00:00Z",
            output: { width: 3840, height: 2160, fps: 29.97 },
            clips: [{ id: "c1", clip_id: "ghost99", in_s: 0, out_s: 5, speed: 1 }],
          });
        }
        return validTimelineJson();
      },
    };
    const { attempts, timeline } = await proposeCut(fixture.project, director, {
      brief: "30 second lodge teaser",
      duration_s: 30,
    });
    expect(attempts).toBe(2);
    expect(prompts[1]).toContain("FAILED validation");
    expect(prompts[1]).toContain("ghost99");
    expect(timeline.version).toBeGreaterThanOrEqual(2); // v1 saved by previous test
  });

  it("fails cleanly after two invalid attempts", async () => {
    const director: DirectorClient = {
      async complete() {
        return "I am unable to produce JSON today.";
      },
    };
    await expect(
      proposeCut(fixture.project, director, { brief: "30 second teaser xxx", duration_s: 30 })
    ).rejects.toThrow(/failed validation after 2 attempts/);
  });

  it("injects the requested music bed, overriding the model", async () => {
    const director: DirectorClient = {
      async complete() {
        const t = JSON.parse(validTimelineJson());
        t.music = { path: "/model/injected.mp3", gain_db: 0, fade_out_s: 0 };
        return JSON.stringify(t);
      },
    };
    const withMusic = await proposeCut(fixture.project, director, {
      brief: "30 second teaser with music",
      duration_s: 30,
      music_path: "/Users/me/music/bed.mp3",
    });
    expect(withMusic.timeline.music?.path).toBe("/Users/me/music/bed.mp3");

    const withoutMusic = await proposeCut(fixture.project, director, {
      brief: "30 second teaser no music",
      duration_s: 30,
    });
    expect(withoutMusic.timeline.music).toBeUndefined();
  });
});
