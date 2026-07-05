import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getActiveProject } from "../core/project.js";
import { proposeCut, createClaudeDirector } from "../core/director.js";
import { summarizeTimeline, computeDuration } from "../core/timeline.js";
import { toolHandler, ok } from "./util.js";

export function registerDirectorTools(server: McpServer): void {
  server.registerTool(
    "skycut_propose_cut",
    {
      title: "Propose cut",
      description:
        "Have the AI director assemble a timeline from the footage graph: narrative arc, varied movement, " +
        "3-8s shots, crossfades, within ±5% of the target duration. Saves an immutable timeline version for " +
        "review — NEVER renders anything itself. " +
        'Example: skycut_propose_cut({ brief: "90s cinematic cut for a fly-in fishing lodge, slow build to reveal", duration_s: 90 })',
      inputSchema: {
        brief: z.string().min(10).describe("Creative brief for the cut"),
        duration_s: z.number().positive().max(600).describe("Target duration in seconds (±5%)"),
        style: z.string().optional().describe('Optional style hints, e.g. "cinematic, warm, slow pacing"'),
        music_path: z.string().optional().describe("Optional absolute path to a music file for the bed"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    toolHandler(async ({ brief, duration_s, style, music_path }) => {
      const project = getActiveProject();
      const { timeline, attempts } = await proposeCut(project, createClaudeDirector(), {
        brief,
        duration_s,
        style,
        music_path,
      });
      return ok(
        `Proposed timeline v${timeline.version} (${computeDuration(timeline).toFixed(1)}s` +
          `${attempts > 1 ? ", passed on retry" : ""}):\n${summarizeTimeline(timeline)}\n\n` +
          `Review the shot list, then skycut_render_preview({ version: ${timeline.version} }) to watch it. ` +
          `Nothing is finalized until you explicitly call skycut_render_final.`,
        { timeline, attempts }
      );
    })
  );
}
