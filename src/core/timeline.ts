import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TimelineSchema, TimelineClipSchema, MusicSchema, TransitionSchema, type Timeline } from "../schemas/timeline.js";
import { UserError } from "./errors.js";
import type { Project } from "./project.js";
import { openDb, getClip } from "./graph.js";

export const DURATION_TOLERANCE = 0.05;

/** Playback duration: clip lengths (speed-adjusted) minus transition overlaps between consecutive clips. */
export function computeDuration(timeline: Timeline): number {
  let total = 0;
  timeline.clips.forEach((clip, i) => {
    total += (clip.out_s - clip.in_s) / clip.speed;
    const isLast = i === timeline.clips.length - 1;
    if (!isLast && clip.transition_out) total -= clip.transition_out.duration_s;
  });
  return Math.round(total * 100) / 100;
}

export interface ValidationContext {
  /** clip_id → source duration in seconds. */
  clipDurations: Map<string, number>;
  /** If set, computed duration must be within ±5%. */
  targetDurationS?: number;
}

/** Parse + semantically validate. Returns the parsed timeline or throws UserError with all problems listed. */
export function validateTimeline(data: unknown, ctx: ValidationContext): Timeline {
  const parsed = TimelineSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new UserError(`Timeline schema invalid:\n${issues.map((i) => `- ${i}`).join("\n")}`);
  }
  const timeline = parsed.data;
  const problems: string[] = [];

  const seenIds = new Set<string>();
  for (const clip of timeline.clips) {
    if (seenIds.has(clip.id)) problems.push(`duplicate timeline clip id '${clip.id}'`);
    seenIds.add(clip.id);
    const duration = ctx.clipDurations.get(clip.clip_id);
    if (duration === undefined) {
      problems.push(`clip '${clip.id}': clip_id '${clip.clip_id}' not found in the footage manifest`);
    } else if (clip.out_s > duration + 0.05) {
      problems.push(
        `clip '${clip.id}': out_s ${clip.out_s} exceeds source duration ${duration.toFixed(2)}s of ${clip.clip_id}`
      );
    }
  }

  for (let i = 0; i < timeline.clips.length; i++) {
    const clip = timeline.clips[i];
    if (clip.transition_out && i < timeline.clips.length - 1) {
      const clipLen = (clip.out_s - clip.in_s) / clip.speed;
      const next = timeline.clips[i + 1];
      const nextLen = (next.out_s - next.in_s) / next.speed;
      if (clip.transition_out.duration_s >= Math.min(clipLen, nextLen)) {
        problems.push(
          `clip '${clip.id}': transition (${clip.transition_out.duration_s}s) is not shorter than the adjacent clips`
        );
      }
    }
  }

  if (ctx.targetDurationS) {
    const total = computeDuration(timeline);
    const drift = Math.abs(total - ctx.targetDurationS) / ctx.targetDurationS;
    if (drift > DURATION_TOLERANCE) {
      problems.push(
        `total duration ${total.toFixed(1)}s is outside ±5% of target ${ctx.targetDurationS}s ` +
          `(allowed ${(ctx.targetDurationS * 0.95).toFixed(1)}–${(ctx.targetDurationS * 1.05).toFixed(1)}s)`
      );
    }
  }

  if (problems.length) {
    throw new UserError(`Timeline validation failed:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
  return timeline;
}

export function validationContextFor(project: Project, targetDurationS?: number): ValidationContext {
  const db = openDb(project);
  try {
    const rows = db.prepare("SELECT clip_id, duration_s FROM clips").all() as Array<{
      clip_id: string;
      duration_s: number;
    }>;
    return { clipDurations: new Map(rows.map((r) => [r.clip_id, r.duration_s])), targetDurationS };
  } finally {
    db.close();
  }
}

// ---- versioning (immutable files: timelines/v<N>.json) ----

export function listVersions(project: Project): number[] {
  if (!fs.existsSync(project.paths.timelines)) return [];
  return fs
    .readdirSync(project.paths.timelines)
    .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
    .filter((v): v is string => !!v)
    .map(Number)
    .sort((a, b) => a - b);
}

export function nextVersion(project: Project): number {
  const versions = listVersions(project);
  return versions.length ? versions[versions.length - 1] + 1 : 1;
}

export function saveTimeline(project: Project, timeline: Omit<Timeline, "version">): Timeline {
  const version = nextVersion(project);
  const finalized: Timeline = { ...timeline, version };
  const file = path.join(project.paths.timelines, `v${version}.json`);
  fs.writeFileSync(file, JSON.stringify(finalized, null, 2), { flag: "wx" }); // wx: never overwrite a version
  return finalized;
}

export function loadTimeline(project: Project, version?: number): Timeline {
  const versions = listVersions(project);
  if (versions.length === 0) {
    throw new UserError("No timelines yet. Run skycut_propose_cut first.");
  }
  const v = version ?? versions[versions.length - 1];
  const file = path.join(project.paths.timelines, `v${v}.json`);
  if (!fs.existsSync(file)) {
    throw new UserError(`Timeline v${v} not found. Available: ${versions.map((x) => `v${x}`).join(", ")}`);
  }
  return TimelineSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

// ---- structured edits ----

export const EditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert"), at_index: z.number().int().min(0), clip: TimelineClipSchema }),
  z.object({ op: z.literal("remove"), id: z.string() }),
  z.object({ op: z.literal("reorder"), id: z.string(), to_index: z.number().int().min(0) }),
  z.object({
    op: z.literal("retrim"),
    id: z.string(),
    in_s: z.number().min(0).optional(),
    out_s: z.number().positive().optional(),
    speed: z.number().min(0.25).max(4).optional(),
  }),
  z.object({ op: z.literal("set_transition"), id: z.string(), transition: TransitionSchema.nullable() }),
  z.object({ op: z.literal("set_music"), music: MusicSchema.nullable() }),
]);

export type TimelineEdit = z.infer<typeof EditSchema>;

function findClipIndex(timeline: Timeline, id: string): number {
  const index = timeline.clips.findIndex((c) => c.id === id);
  if (index === -1) {
    throw new UserError(`No timeline clip with id '${id}'. Ids: ${timeline.clips.map((c) => c.id).join(", ")}`);
  }
  return index;
}

/** Apply one structured edit, returning a NEW timeline body (unversioned) + a human-readable summary line. */
export function applyEdit(timeline: Timeline, edit: TimelineEdit): { result: Omit<Timeline, "version">; summary: string } {
  const next: Timeline = structuredClone(timeline);
  let summary: string;

  switch (edit.op) {
    case "insert": {
      if (next.clips.some((c) => c.id === edit.clip.id)) {
        throw new UserError(`Clip id '${edit.clip.id}' already exists in the timeline.`);
      }
      const at = Math.min(edit.at_index, next.clips.length);
      next.clips.splice(at, 0, edit.clip);
      summary = `inserted '${edit.clip.id}' (${edit.clip.clip_id} ${edit.clip.in_s}–${edit.clip.out_s}s) at position ${at}`;
      break;
    }
    case "remove": {
      const index = findClipIndex(next, edit.id);
      const [removed] = next.clips.splice(index, 1);
      summary = `removed '${removed.id}' (${removed.label ?? removed.clip_id})`;
      break;
    }
    case "reorder": {
      const from = findClipIndex(next, edit.id);
      const [clip] = next.clips.splice(from, 1);
      const to = Math.min(edit.to_index, next.clips.length);
      next.clips.splice(to, 0, clip);
      summary = `moved '${edit.id}' from position ${from} to ${to}`;
      break;
    }
    case "retrim": {
      const clip = next.clips[findClipIndex(next, edit.id)];
      const before = `${clip.in_s}–${clip.out_s}s @${clip.speed}x`;
      if (edit.in_s !== undefined) clip.in_s = edit.in_s;
      if (edit.out_s !== undefined) clip.out_s = edit.out_s;
      if (edit.speed !== undefined) clip.speed = edit.speed;
      summary = `retrimmed '${edit.id}': ${before} → ${clip.in_s}–${clip.out_s}s @${clip.speed}x`;
      break;
    }
    case "set_transition": {
      const clip = next.clips[findClipIndex(next, edit.id)];
      if (edit.transition === null) {
        delete clip.transition_out;
        summary = `removed transition after '${edit.id}' (hard cut)`;
      } else {
        clip.transition_out = edit.transition;
        summary = `set ${edit.transition.style} ${edit.transition.duration_s}s transition after '${edit.id}'`;
      }
      break;
    }
    case "set_music": {
      if (edit.music === null) {
        delete next.music;
        summary = "removed music bed";
      } else {
        next.music = edit.music;
        summary = `set music: ${path.basename(edit.music.path)} (${edit.music.gain_db} dB, ${edit.music.fade_out_s}s fade-out)`;
      }
      break;
    }
  }

  const { version: _dropped, ...body } = next;
  return { result: body, summary };
}

export function summarizeTimeline(timeline: Timeline, clipPaths?: Map<string, string>): string {
  const lines = [
    `Timeline v${timeline.version} — ${timeline.clips.length} shots, ${computeDuration(timeline).toFixed(1)}s ` +
      `@ ${timeline.output.width}x${timeline.output.height} ${timeline.output.fps}fps` +
      (timeline.music ? `, music: ${path.basename(timeline.music.path)}` : ", no music"),
  ];
  let t = 0;
  timeline.clips.forEach((clip, i) => {
    const len = (clip.out_s - clip.in_s) / clip.speed;
    const source = clipPaths?.get(clip.clip_id) ?? clip.clip_id;
    lines.push(
      `  ${String(i + 1).padStart(2)}. [${t.toFixed(1)}s] ${clip.id} ${source} ` +
        `${clip.in_s.toFixed(1)}–${clip.out_s.toFixed(1)}s` +
        (clip.speed !== 1 ? ` @${clip.speed}x` : "") +
        (clip.label ? ` — ${clip.label}` : "") +
        (clip.transition_out && i < timeline.clips.length - 1
          ? ` → ${clip.transition_out.style} ${clip.transition_out.duration_s}s`
          : "")
    );
    t += len - (i < timeline.clips.length - 1 && clip.transition_out ? clip.transition_out.duration_s : 0);
  });
  for (const overlay of timeline.text_overlays ?? []) {
    lines.push(`  text "${overlay.text}" ${overlay.t_in}–${overlay.t_out}s (${overlay.position}, ${overlay.size})`);
  }
  return lines.join("\n");
}

/** Lookup used by getClip re-export for tools. */
export { getClip };
