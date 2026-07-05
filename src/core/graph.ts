import Database from "better-sqlite3";
import type { Project } from "./project.js";

export interface ClipRow {
  clip_id: string;
  rel_path: string;
  abs_path: string;
  size_bytes: number;
  duration_s: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrate: number | null;
  created_time: string | null;
  gps: string | null;
  proxy_path: string | null;
  analyzed: number;
}

export interface SegmentRow {
  id: number;
  clip_id: string;
  t_in: number;
  t_out: number;
  subjects: string; // JSON array
  movement: string;
  avg_aesthetic: number;
  exposure: string;
  horizon: string;
  stability: string;
  notes: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clips (
  clip_id      TEXT PRIMARY KEY,
  rel_path     TEXT NOT NULL,
  abs_path     TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  duration_s   REAL NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  fps          REAL NOT NULL,
  codec        TEXT NOT NULL,
  bitrate      INTEGER,
  created_time TEXT,
  gps          TEXT,
  proxy_path   TEXT,
  analyzed     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS segments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id       TEXT NOT NULL REFERENCES clips(clip_id) ON DELETE CASCADE,
  t_in          REAL NOT NULL,
  t_out         REAL NOT NULL,
  subjects      TEXT NOT NULL,
  movement      TEXT NOT NULL,
  avg_aesthetic REAL NOT NULL,
  exposure      TEXT NOT NULL DEFAULT 'good',
  horizon       TEXT NOT NULL DEFAULT 'level',
  stability     TEXT NOT NULL DEFAULT 'smooth',
  notes         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_segments_clip ON segments(clip_id);
CREATE INDEX IF NOT EXISTS idx_segments_score ON segments(avg_aesthetic DESC);
`;

export function openDb(project: Project): Database.Database {
  const db = new Database(project.paths.db);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export function upsertClip(db: Database.Database, clip: Omit<ClipRow, "analyzed">): void {
  db.prepare(
    `INSERT INTO clips (clip_id, rel_path, abs_path, size_bytes, duration_s, width, height, fps, codec, bitrate, created_time, gps, proxy_path)
     VALUES (@clip_id, @rel_path, @abs_path, @size_bytes, @duration_s, @width, @height, @fps, @codec, @bitrate, @created_time, @gps, @proxy_path)
     ON CONFLICT(clip_id) DO UPDATE SET
       abs_path = excluded.abs_path,
       proxy_path = COALESCE(excluded.proxy_path, clips.proxy_path)`
  ).run(clip);
}

export function getClips(db: Database.Database): ClipRow[] {
  return db.prepare("SELECT * FROM clips ORDER BY rel_path").all() as ClipRow[];
}

export function getClip(db: Database.Database, clipId: string): ClipRow | undefined {
  return db.prepare("SELECT * FROM clips WHERE clip_id = ?").get(clipId) as ClipRow | undefined;
}

export function markAnalyzed(db: Database.Database, clipId: string): void {
  db.prepare("UPDATE clips SET analyzed = 1 WHERE clip_id = ?").run(clipId);
}

export function replaceSegments(
  db: Database.Database,
  clipId: string,
  segments: Array<Omit<SegmentRow, "id" | "clip_id">>
): void {
  const del = db.prepare("DELETE FROM segments WHERE clip_id = ?");
  const ins = db.prepare(
    `INSERT INTO segments (clip_id, t_in, t_out, subjects, movement, avg_aesthetic, exposure, horizon, stability, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    del.run(clipId);
    for (const s of segments) {
      ins.run(clipId, s.t_in, s.t_out, s.subjects, s.movement, s.avg_aesthetic, s.exposure, s.horizon, s.stability, s.notes);
    }
  })();
}
