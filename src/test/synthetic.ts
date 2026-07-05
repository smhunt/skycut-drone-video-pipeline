import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initProject, type Project } from "../core/project.js";
import { openDb, upsertClip, replaceSegments, markAnalyzed } from "../core/graph.js";

/**
 * Synthetic fly-in fishing lodge footage graph: 5 clips, 12 scored segments.
 * No media files — for exercising the director, timeline, search, and evals without ffmpeg.
 */
export function createSyntheticProject(): { project: Project; home: string; source: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skycut-home-"));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "skycut-src-"));
  process.env.SKYCUT_HOME = home;
  const project = initProject(source, "Synthetic Lodge");

  const db = openDb(project);
  const clips = [
    { clip_id: "aerial01", rel_path: "DJI_0001.MP4", duration_s: 120 },
    { clip_id: "lodge02", rel_path: "DJI_0002.MP4", duration_s: 90 },
    { clip_id: "dock03", rel_path: "DJI_0003.MP4", duration_s: 60 },
    { clip_id: "plane04", rel_path: "DJI_0004.MP4", duration_s: 45 },
    { clip_id: "sunset05", rel_path: "DJI_0005.MP4", duration_s: 80 },
  ];
  for (const c of clips) {
    upsertClip(db, {
      clip_id: c.clip_id,
      rel_path: c.rel_path,
      abs_path: path.join(source, c.rel_path),
      size_bytes: 1_000_000,
      duration_s: c.duration_s,
      width: 3840,
      height: 2160,
      fps: 29.97,
      codec: "hevc",
      bitrate: 100_000_000,
      created_time: "2026-06-20T18:30:00Z",
      gps: "+51.5000-090.2500/",
      proxy_path: null,
    });
  }

  const seg = (
    t_in: number,
    t_out: number,
    subjects: string[],
    movement: string,
    aesthetic: number,
    notes: string,
    quality: Partial<{ exposure: string; horizon: string; stability: string }> = {}
  ) => ({
    t_in,
    t_out,
    subjects: JSON.stringify(subjects.sort()),
    movement,
    avg_aesthetic: aesthetic,
    exposure: quality.exposure ?? "good",
    horizon: quality.horizon ?? "level",
    stability: quality.stability ?? "smooth",
    notes,
  });

  replaceSegments(db, "aerial01", [
    seg(0, 40, ["forest", "lake"], "flyover", 7.5, "endless boreal forest and open water"),
    seg(40, 80, ["lake", "shoreline"], "push-in", 8.2, "approaching the shoreline over calm water"),
    seg(80, 120, ["shoreline", "trees"], "pan", 5.1, "slightly flat light along shore", { exposure: "under" }),
  ]);
  replaceSegments(db, "lodge02", [
    seg(0, 30, ["lodge", "shoreline"], "orbit", 9.1, "golden light on lodge roofline"),
    seg(30, 55, ["lodge", "dock"], "reveal", 8.8, "lodge revealed from behind treeline"),
    seg(55, 90, ["lodge"], "static", 6.0, "static hold on lodge, slight jitter", { stability: "jittery" }),
  ]);
  replaceSegments(db, "dock03", [
    seg(0, 25, ["dock", "boat"], "push-in", 7.9, "boats tied at the dock, morning mist"),
    seg(25, 60, ["dock", "guests", "lodge"], "static", 6.5, "guests loading gear below the lodge"),
  ]);
  replaceSegments(db, "plane04", [
    seg(0, 20, ["floatplane", "lake"], "orbit", 8.6, "floatplane taxiing across the bay"),
    seg(20, 45, ["floatplane", "sky"], "pull-back", 7.2, "takeoff run, spray off the floats"),
  ]);
  replaceSegments(db, "sunset05", [
    seg(0, 45, ["sunset", "lake"], "pull-back", 9.4, "wide sunset pull-back over glassy water"),
    seg(45, 80, ["sunset", "lodge"], "static", 8.0, "last light behind the lodge", { exposure: "over" }),
  ]);

  for (const c of clips) markAnalyzed(db, c.clip_id);
  db.close();
  return { project, home, source };
}

export function destroySyntheticProject(fixture: { home: string; source: string }): void {
  delete process.env.SKYCUT_HOME;
  fs.rmSync(fixture.home, { recursive: true, force: true });
  fs.rmSync(fixture.source, { recursive: true, force: true });
}
