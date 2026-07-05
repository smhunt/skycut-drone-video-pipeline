import type Database from "better-sqlite3";
import type { Project } from "./project.js";
import { openDb, getClips, replaceSegments, markAnalyzed, type ClipRow, type SegmentRow } from "./graph.js";
import { sampleFrames, estimateFrameCount, FRAME_INTERVAL_S } from "./frames.js";
import { BATCH_SIZE, TOKENS_PER_FRAME, type FrameAnalysis, type VisionClient } from "./vision.js";
import type { ProgressReporter } from "./progress.js";
import { mapConcurrent } from "./concurrency.js";

/** Concurrent clips in flight — keeps vision API throughput high without tripping rate limits. */
const ANALYZE_CONCURRENCY = 3;

export const CONFIRM_THRESHOLD_FRAMES = 500;

export interface AnalyzeEstimate {
  needsConfirmation: true;
  pendingClips: number;
  estimatedFrames: number;
  estimatedTokens: number;
}

export interface AnalyzeResult {
  needsConfirmation: false;
  clipsAnalyzed: number;
  clipsSkipped: number;
  framesAnalyzed: number;
  segmentCount: number;
  topSubjects: Array<{ subject: string; count: number }>;
  errors: string[];
}

/**
 * Merge consecutive frame analyses with identical subjects+movement into scored segments.
 * Exported for unit testing.
 */
export function mergeIntoSegments(
  analyses: FrameAnalysis[],
  clipDurationS: number
): Array<Omit<SegmentRow, "id" | "clip_id">> {
  const sorted = [...analyses].sort((a, b) => a.t - b.t);
  const segments: Array<Omit<SegmentRow, "id" | "clip_id">> = [];
  let group: FrameAnalysis[] = [];

  const keyOf = (f: FrameAnalysis) => `${[...f.subjects].sort().join(",")}|${f.movement}`;

  const flush = () => {
    if (group.length === 0) return;
    const mode = (values: string[]) => {
      const counts = new Map<string, number>();
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };
    const first = group[0];
    const last = group[group.length - 1];
    segments.push({
      t_in: first.t,
      t_out: Math.min(last.t + FRAME_INTERVAL_S, clipDurationS),
      subjects: JSON.stringify([...first.subjects].sort()),
      movement: first.movement,
      avg_aesthetic: Math.round((group.reduce((s, f) => s + f.aesthetic, 0) / group.length) * 10) / 10,
      exposure: mode(group.map((f) => f.quality.exposure)),
      horizon: mode(group.map((f) => f.quality.horizon)),
      stability: mode(group.map((f) => f.quality.stability)),
      notes: group.map((f) => f.notes).filter(Boolean).join("; ").slice(0, 300),
    });
    group = [];
  };

  for (const frame of sorted) {
    if (group.length > 0 && keyOf(group[0]) !== keyOf(frame)) flush();
    group.push(frame);
  }
  flush();
  return segments;
}

export interface AnalyzeOptions {
  force?: boolean;
  confirm?: boolean;
}

export async function analyzeFootage(
  project: Project,
  vision: VisionClient,
  opts: AnalyzeOptions = {},
  onProgress?: ProgressReporter
): Promise<AnalyzeEstimate | AnalyzeResult> {
  const db = openDb(project);
  try {
    const clips = getClips(db);
    const pending = clips.filter((c) => opts.force || !c.analyzed);

    const estimatedFrames = pending.reduce((sum, c) => sum + estimateFrameCount(c.duration_s), 0);
    if (estimatedFrames > CONFIRM_THRESHOLD_FRAMES && !opts.confirm) {
      return {
        needsConfirmation: true,
        pendingClips: pending.length,
        estimatedFrames,
        estimatedTokens: estimatedFrames * TOKENS_PER_FRAME,
      };
    }

    let framesAnalyzed = 0;
    let clipsAnalyzed = 0;
    let completed = 0;
    const errors: string[] = [];

    await mapConcurrent(pending, ANALYZE_CONCURRENCY, async (clip) => {
      try {
        const frames = await sampleFrames(project, clip);
        const analyses: FrameAnalysis[] = [];
        for (let i = 0; i < frames.length; i += BATCH_SIZE) {
          analyses.push(...(await vision.analyzeBatch(frames.slice(i, i + BATCH_SIZE))));
        }
        replaceSegments(db, clip.clip_id, mergeIntoSegments(analyses, clip.duration_s));
        markAnalyzed(db, clip.clip_id);
        framesAnalyzed += frames.length;
        clipsAnalyzed++;
        onProgress?.(++completed, pending.length, `analyzed ${clip.rel_path} (${frames.length} frames)`);
      } catch (err) {
        errors.push(`${clip.rel_path}: ${err instanceof Error ? err.message : String(err)}`);
        onProgress?.(++completed, pending.length, `failed ${clip.rel_path}`);
      }
    });

    return {
      needsConfirmation: false,
      clipsAnalyzed,
      clipsSkipped: clips.length - pending.length,
      framesAnalyzed,
      segmentCount: countSegments(db),
      topSubjects: topSubjects(db),
      errors,
    };
  } finally {
    db.close();
  }
}

function countSegments(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM segments").get() as { n: number }).n;
}

export function topSubjects(db: Database.Database, limit = 10): Array<{ subject: string; count: number }> {
  const rows = db.prepare("SELECT subjects FROM segments").all() as Array<{ subjects: string }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const subject of JSON.parse(row.subjects) as string[]) {
      counts.set(subject, (counts.get(subject) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([subject, count]) => ({ subject, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export interface MomentQuery {
  subject?: string;
  movement?: string;
  min_aesthetic?: number;
  stability?: string;
  exposure?: string;
  text?: string;
  limit?: number;
}

export interface MomentResult extends Omit<SegmentRow, "subjects"> {
  subjects: string[];
  rel_path: string;
}

export function searchMoments(project: Project, query: MomentQuery): MomentResult[] {
  const db = openDb(project);
  try {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (query.subject) {
      where.push("s.subjects LIKE @subject");
      params.subject = `%"${query.subject.toLowerCase()}"%`;
    }
    if (query.movement) {
      where.push("s.movement = @movement");
      params.movement = query.movement;
    }
    if (query.min_aesthetic !== undefined) {
      where.push("s.avg_aesthetic >= @min_aesthetic");
      params.min_aesthetic = query.min_aesthetic;
    }
    if (query.stability) {
      where.push("s.stability = @stability");
      params.stability = query.stability;
    }
    if (query.exposure) {
      where.push("s.exposure = @exposure");
      params.exposure = query.exposure;
    }
    if (query.text) {
      where.push("(s.notes LIKE @text OR s.subjects LIKE @text)");
      params.text = `%${query.text}%`;
    }
    const sql = `
      SELECT s.*, c.rel_path FROM segments s
      JOIN clips c ON c.clip_id = s.clip_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.avg_aesthetic DESC
      LIMIT @limit`;
    params.limit = Math.min(query.limit ?? 25, 200);
    const rows = db.prepare(sql).all(params) as Array<SegmentRow & { rel_path: string }>;
    return rows.map((r) => ({ ...r, subjects: JSON.parse(r.subjects) as string[] }));
  } finally {
    db.close();
  }
}
