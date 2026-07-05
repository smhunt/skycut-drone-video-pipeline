import Anthropic from "@anthropic-ai/sdk";
import { UserError } from "./errors.js";
import type { Project } from "./project.js";
import { openDb } from "./graph.js";
import { validateTimeline, validationContextFor, saveTimeline, computeDuration } from "./timeline.js";
import type { Timeline } from "../schemas/timeline.js";

export const DIRECTOR_MODEL = "claude-sonnet-4-6";
const MAX_GRAPH_SEGMENTS = 150;

export interface DirectorClient {
  complete(system: string, user: string): Promise<string>;
}

export function createClaudeDirector(): DirectorClient {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new UserError(
      "ANTHROPIC_API_KEY is not set — required for cut proposal. Add it to the MCP server env config."
    );
  }
  const client = new Anthropic();
  return {
    async complete(system, user) {
      const response = await client.messages.create({
        model: DIRECTOR_MODEL,
        max_tokens: 8192,
        system,
        messages: [{ role: "user", content: user }],
      });
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    },
  };
}

interface GraphSegment {
  clip_id: string;
  clip_duration_s: number;
  t_in: number;
  t_out: number;
  subjects: string[];
  movement: string;
  aesthetic: number;
  exposure: string;
  horizon: string;
  stability: string;
  notes: string;
}

/** Compact footage graph for the director prompt: top segments by aesthetic score. */
export function buildFootageGraph(project: Project): { segments: GraphSegment[]; output: Timeline["output"] } {
  const db = openDb(project);
  try {
    const rows = db
      .prepare(
        `SELECT s.*, c.duration_s AS clip_duration_s, c.width, c.height, c.fps
         FROM segments s JOIN clips c ON c.clip_id = s.clip_id
         ORDER BY s.avg_aesthetic DESC LIMIT ?`
      )
      .all(MAX_GRAPH_SEGMENTS) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      throw new UserError("Footage graph is empty — run skycut_scan_footage then skycut_analyze_footage first.");
    }
    const segments = rows.map((r) => ({
      clip_id: String(r.clip_id),
      clip_duration_s: Math.round(Number(r.clip_duration_s) * 10) / 10,
      t_in: Number(r.t_in),
      t_out: Number(r.t_out),
      subjects: JSON.parse(String(r.subjects)) as string[],
      movement: String(r.movement),
      aesthetic: Number(r.avg_aesthetic),
      exposure: String(r.exposure),
      horizon: String(r.horizon),
      stability: String(r.stability),
      notes: String(r.notes),
    }));

    // Output format: the dominant source resolution/fps, capped at 4K.
    const res = db
      .prepare(
        `SELECT width, height, fps, COUNT(*) AS n FROM clips GROUP BY width, height, fps ORDER BY n DESC LIMIT 1`
      )
      .get() as { width: number; height: number; fps: number };
    const cap = Math.min(1, 3840 / res.width, 2160 / res.height);
    const output = {
      width: Math.round((res.width * cap) / 2) * 2,
      height: Math.round((res.height * cap) / 2) * 2,
      fps: res.fps,
    };
    return { segments, output };
  } finally {
    db.close();
  }
}

const SYSTEM_PROMPT = `You are a film director assembling a drone-footage marketing cut.
You receive a footage graph: scored segments of source clips (subjects, camera movement, quality flags, aesthetic 0-10, timestamps within each source clip).

Build a timeline that:
- follows a narrative arc: establish → reveal → activity → beauty shots → closing
- prefers smooth, level, well-exposed segments (stability=smooth, horizon=level, exposure=good)
- varies camera movement between adjacent shots; avoid two identical movements in a row
- uses shot lengths of 3-8 seconds (in_s/out_s must lie INSIDE the chosen segment's [t_in, t_out] range, and within the source clip duration)
- lands the TOTAL duration (sum of shot lengths minus 0.75s per crossfade) within ±5% of the requested target
- uses xfade transitions (type "xfade", style "fade", duration_s 0.75) on every clip except the last

Output ONLY valid JSON (no prose, no markdown fences) matching:
{
  "project": "<given>",
  "created": "<given ISO date>",
  "output": <the exact "output" object given>,
  "clips": [
    { "id": "c1", "clip_id": "<from footage graph>", "in_s": <number>, "out_s": <number>, "speed": 1.0,
      "transition_out": { "type": "xfade", "style": "fade", "duration_s": 0.75 },
      "label": "<short description>" }
  ],
  "text_overlays": []
}
The FINAL clip must have no "transition_out" key. Do not invent clip_ids.`;

export interface ProposeCutInput {
  brief: string;
  duration_s: number;
  style?: string;
  music_path?: string;
}

export interface ProposeCutResult {
  timeline: Timeline;
  attempts: number;
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new UserError(`Director response was not JSON:\n${cleaned.slice(0, 300)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function proposeCut(
  project: Project,
  director: DirectorClient,
  input: ProposeCutInput
): Promise<ProposeCutResult> {
  const graph = buildFootageGraph(project);
  const created = new Date().toISOString();
  const ctx = validationContextFor(project, input.duration_s);

  const userPrompt = (extra?: string) =>
    [
      `Brief: ${input.brief}`,
      `Target duration: ${input.duration_s} seconds (hard requirement, ±5%)`,
      input.style ? `Style: ${input.style}` : null,
      `project: "${project.meta.slug}"`,
      `created: "${created}"`,
      `output: ${JSON.stringify(graph.output)}`,
      `Footage graph (${graph.segments.length} segments, best first):`,
      JSON.stringify(graph.segments),
      extra ? `\nYour previous attempt FAILED validation:\n${extra}\nFix these problems and output the corrected JSON.` : null,
    ]
      .filter(Boolean)
      .join("\n");

  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await director.complete(SYSTEM_PROMPT, userPrompt(attempt === 1 ? undefined : lastError));
    try {
      const data = extractJson(raw) as Record<string, unknown>;
      // The server owns version/music, not the model.
      delete data.version;
      if (input.music_path) {
        data.music = { path: input.music_path, gain_db: -6, fade_out_s: 2 };
      } else {
        delete data.music;
      }
      const validated = validateTimeline({ ...data, version: 1 }, ctx);
      const { version: _v, ...body } = validated;
      const saved = saveTimeline(project, body);
      return { timeline: saved, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new UserError(
    `Cut proposal failed validation after 2 attempts. Last errors:\n${lastError}\n` +
      `Try a different duration or a broader brief, or check that analysis produced enough segments.`
  );
}

export { computeDuration };
