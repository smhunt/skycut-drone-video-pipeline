import fs from "node:fs";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { UserError } from "./errors.js";
import type { SampledFrame } from "./frames.js";

export const MOVEMENTS = ["orbit", "push-in", "pull-back", "flyover", "pan", "static", "reveal"] as const;

export const FrameAnalysisSchema = z.object({
  t: z.number(),
  subjects: z.array(z.string()).min(1),
  movement: z.string().transform((m) => (MOVEMENTS.includes(m as (typeof MOVEMENTS)[number]) ? m : "static")),
  quality: z.object({
    exposure: z.enum(["good", "over", "under"]).catch("good"),
    horizon: z.enum(["level", "tilted"]).catch("level"),
    stability: z.enum(["smooth", "jittery"]).catch("smooth"),
  }),
  aesthetic: z.number().min(0).max(10).catch(5),
  notes: z.string().catch(""),
});

export type FrameAnalysis = z.infer<typeof FrameAnalysisSchema>;

export interface VisionClient {
  analyzeBatch(frames: SampledFrame[]): Promise<FrameAnalysis[]>;
}

export const BATCH_SIZE = 8;
export const TOKENS_PER_FRAME = 1200;
export const VISION_MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You analyze drone footage keyframes for a video editing pipeline.
For EACH frame provided, output one JSON object. Respond with ONLY a JSON array — no prose, no markdown fences.

Per-frame object:
{
  "t": <the timestamp given for the frame, as a number>,
  "subjects": ["lodge", "dock", "shoreline", ...],  // 1-5 concrete visible subjects, lowercase
  "movement": "orbit|push-in|pull-back|flyover|pan|static|reveal",  // inferred camera movement
  "quality": { "exposure": "good|over|under", "horizon": "level|tilted", "stability": "smooth|jittery" },
  "aesthetic": 0-10,  // cinematic appeal
  "notes": "short phrase, e.g. 'golden light on lodge roofline'"
}`;

export function createClaudeVision(): VisionClient {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new UserError(
      "ANTHROPIC_API_KEY is not set — required for vision analysis. Add it to the MCP server env config."
    );
  }
  const client = new Anthropic();
  return {
    async analyzeBatch(frames) {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const frame of frames) {
        content.push({ type: "text", text: `Frame at t=${frame.t.toFixed(1)}s:` });
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: fs.readFileSync(frame.path).toString("base64"),
          },
        });
      }
      content.push({
        type: "text",
        text: `Analyze all ${frames.length} frames. Output a JSON array with exactly ${frames.length} objects, in order.`,
      });

      const response = await client.messages.create({
        model: VISION_MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return parseFrameAnalyses(text, frames);
    },
  };
}

/** Parse + validate the model's JSON array; salvage per-frame, falling back to the given timestamps. */
export function parseFrameAnalyses(text: string, frames: SampledFrame[]): FrameAnalysis[] {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) {
    throw new UserError(`Vision response was not a JSON array:\n${cleaned.slice(0, 300)}`);
  }
  let raw: unknown[];
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1)) as unknown[];
  } catch (err) {
    throw new UserError(`Vision response JSON parse failed: ${err instanceof Error ? err.message : err}`);
  }
  const results: FrameAnalysis[] = [];
  raw.forEach((item, i) => {
    const parsed = FrameAnalysisSchema.safeParse(item);
    if (parsed.success) {
      // Trust our own timestamps over the model's echo.
      results.push({ ...parsed.data, t: frames[i]?.t ?? parsed.data.t });
    }
  });
  if (results.length === 0) {
    throw new UserError("Vision response contained no valid frame analyses.");
  }
  return results;
}
