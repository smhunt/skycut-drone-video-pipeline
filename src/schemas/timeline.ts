import { z } from "zod";

export const TransitionSchema = z.object({
  type: z.literal("xfade"),
  style: z.string().default("fade").describe("xfade style, e.g. fade, dissolve, wipeleft"),
  duration_s: z.number().positive().max(3).default(0.75),
});

export const TimelineClipSchema = z
  .object({
    id: z.string().min(1).describe("Timeline-local id, e.g. c1"),
    clip_id: z.string().min(1).describe("FK into the footage graph (clips table)"),
    in_s: z.number().min(0).describe("Source in-point, seconds"),
    out_s: z.number().positive().describe("Source out-point, seconds"),
    speed: z.number().min(0.25).max(4).default(1),
    transition_out: TransitionSchema.optional().describe("Transition into the NEXT clip"),
    label: z.string().optional(),
  })
  .refine((c) => c.out_s > c.in_s, { message: "out_s must be greater than in_s" });

export const MusicSchema = z.object({
  path: z.string().min(1),
  gain_db: z.number().default(-6),
  fade_out_s: z.number().min(0).default(2),
});

export const TextOverlaySchema = z.object({
  text: z.string().min(1),
  t_in: z.number().min(0),
  t_out: z.number().positive(),
  position: z.enum(["lower-third", "center", "top"]).default("lower-third"),
  size: z.enum(["small", "medium", "large"]).default("medium"),
});

export const TimelineSchema = z.object({
  version: z.number().int().positive(),
  project: z.string().min(1),
  created: z.string(),
  output: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
  }),
  music: MusicSchema.optional(),
  clips: z.array(TimelineClipSchema).min(1),
  text_overlays: z.array(TextOverlaySchema).optional(),
});

export type Transition = z.infer<typeof TransitionSchema>;
export type TimelineClip = z.infer<typeof TimelineClipSchema>;
export type Music = z.infer<typeof MusicSchema>;
export type TextOverlay = z.infer<typeof TextOverlaySchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
