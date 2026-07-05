import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getActiveProject } from "../core/project.js";
import {
  loadTimeline,
  listVersions,
  saveTimeline,
  applyEdit,
  validateTimeline,
  validationContextFor,
  summarizeTimeline,
  computeDuration,
  EditSchema,
} from "../core/timeline.js";
import { toolHandler, ok } from "./util.js";

export function registerTimelineTools(server: McpServer): void {
  server.registerTool(
    "skycut_get_timeline",
    {
      title: "Get timeline",
      description: "Return a timeline version (latest by default) as JSON plus a human-readable shot list.",
      inputSchema: {
        version: z.number().int().positive().optional().describe("Timeline version; omit for latest"),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(async ({ version }) => {
      const project = getActiveProject();
      const timeline = loadTimeline(project, version);
      return ok(summarizeTimeline(timeline), {
        timeline,
        versions: listVersions(project),
        duration_s: computeDuration(timeline),
      });
    })
  );

  server.registerTool(
    "skycut_apply_timeline_edit",
    {
      title: "Edit timeline",
      description:
        "Apply structured edits to the latest (or given) timeline version, or replace it wholesale. " +
        "Versions are immutable — the result is always saved as a NEW version. " +
        'Ops: insert {at_index, clip}, remove {id}, reorder {id, to_index}, retrim {id, in_s?, out_s?, speed?}, ' +
        "set_transition {id, transition|null}, set_music {music|null}. " +
        'Example: { edits: [{ op: "retrim", id: "c3", out_s: 51.0 }] }',
      inputSchema: {
        edits: z.array(EditSchema).optional().describe("Structured edit operations, applied in order"),
        timeline: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Full replacement timeline JSON (alternative to edits)"),
        base_version: z.number().int().positive().optional().describe("Version to edit; omit for latest"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    toolHandler(async ({ edits, timeline: replacement, base_version }) => {
      const project = getActiveProject();
      if (!edits?.length && !replacement) {
        return ok("Nothing to do — provide `edits` (structured ops) or `timeline` (full replacement).");
      }

      const ctx = validationContextFor(project);
      const summaries: string[] = [];
      let body: Parameters<typeof saveTimeline>[1];

      if (replacement) {
        const validated = validateTimeline({ version: 1, ...replacement }, ctx);
        const { version: _v, ...rest } = validated;
        body = { ...rest, created: new Date().toISOString() };
        summaries.push("full timeline replacement");
      } else {
        let current = loadTimeline(project, base_version);
        for (const edit of edits!) {
          const { result, summary } = applyEdit(current, edit);
          summaries.push(summary);
          current = { ...result, version: current.version };
        }
        const { version: _v, ...rest } = current;
        body = { ...rest, created: new Date().toISOString() };
      }

      // Validate the final state before persisting.
      validateTimeline({ ...body, version: 999 }, ctx);
      const saved = saveTimeline(project, body);

      return ok(
        `Saved timeline v${saved.version} (${computeDuration(saved).toFixed(1)}s):\n` +
          summaries.map((s) => `- ${s}`).join("\n") +
          `\n\n${summarizeTimeline(saved)}`,
        { timeline: saved, changes: summaries }
      );
    })
  );
}
