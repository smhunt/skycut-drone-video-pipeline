import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getActiveProject } from "../core/project.js";
import { analyzeFootage, searchMoments } from "../core/analyze.js";
import { createClaudeVision, MOVEMENTS } from "../core/vision.js";
import { toolHandler, ok } from "./util.js";

export function registerAnalyzeTools(server: McpServer): void {
  server.registerTool(
    "skycut_analyze_footage",
    {
      title: "Analyze footage (vision)",
      description:
        "Sample keyframes (1 per 4s) from every scanned clip and analyze them with Claude vision to build the " +
        "footage graph: scored segments with subjects, camera movement, and quality flags. Cached — already-analyzed " +
        "clips are skipped unless force=true. If the run needs >500 frames, returns a cost estimate instead; " +
        "re-call with confirm=true to proceed.",
      inputSchema: {
        force: z.boolean().optional().describe("Re-analyze clips even if cached"),
        confirm: z.boolean().optional().describe("Proceed with a large (>500 frame) run after seeing the estimate"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    toolHandler(async ({ force, confirm }) => {
      const project = getActiveProject();
      const result = await analyzeFootage(project, createClaudeVision(), { force, confirm });
      if (result.needsConfirmation) {
        return ok(
          `Large run: ${result.pendingClips} clips → ~${result.estimatedFrames} frames ` +
            `(~${Math.round(result.estimatedTokens / 1000)}k tokens of vision input). ` +
            `Confirm with the user, then re-call skycut_analyze_footage({ confirm: true }).`,
          { ...result }
        );
      }
      let text =
        `Analyzed ${result.clipsAnalyzed} clips (${result.framesAnalyzed} frames), ` +
        `${result.clipsSkipped} already cached. Footage graph: ${result.segmentCount} segments.\n` +
        `Top subjects: ${result.topSubjects.map((s) => `${s.subject} (${s.count})`).join(", ") || "none"}`;
      if (result.errors.length) {
        text += `\n${result.errors.length} clip(s) failed:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
      }
      text += `\nNext: skycut_propose_cut(brief, duration_s) or skycut_search_moments to explore.`;
      return ok(text, { ...result });
    })
  );

  server.registerTool(
    "skycut_search_moments",
    {
      title: "Search moments",
      description:
        "Query the footage graph for segments by subject, camera movement, quality, aesthetic score, or free text " +
        'against notes. Example: { subject: "lodge", movement: "orbit", min_aesthetic: 7 }',
      inputSchema: {
        subject: z.string().optional().describe('Exact subject tag, e.g. "lodge", "dock", "shoreline"'),
        movement: z.enum(MOVEMENTS).optional().describe("Camera movement type"),
        min_aesthetic: z.number().min(0).max(10).optional().describe("Minimum aesthetic score (0-10)"),
        stability: z.enum(["smooth", "jittery"]).optional(),
        exposure: z.enum(["good", "over", "under"]).optional(),
        text: z.string().optional().describe("Free text matched against notes and subjects"),
        limit: z.number().int().positive().max(200).optional().describe("Max results (default 25)"),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(async (query) => {
      const project = getActiveProject();
      const moments = searchMoments(project, query);
      if (moments.length === 0) return ok("No matching segments.", { moments: [] });
      const lines = moments.map(
        (m) =>
          `[${m.clip_id}] ${m.rel_path} ${m.t_in.toFixed(1)}–${m.t_out.toFixed(1)}s ` +
          `${m.movement} ${m.subjects.join("/")} aes=${m.avg_aesthetic}` +
          (m.notes ? ` — ${m.notes.slice(0, 80)}` : "")
      );
      return ok(`${moments.length} segments:\n${lines.join("\n")}`, { moments });
    })
  );
}
