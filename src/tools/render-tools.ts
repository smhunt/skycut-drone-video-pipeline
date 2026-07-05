import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getActiveProject } from "../core/project.js";
import { loadTimeline } from "../core/timeline.js";
import { renderTimeline } from "../core/render.js";
import { toolHandler, ok, progressReporter } from "./util.js";

export function registerRenderTools(server: McpServer): void {
  server.registerTool(
    "skycut_render_preview",
    {
      title: "Render preview",
      description:
        "Fast 720p preview render of a timeline version (latest by default) from proxies — works even with the " +
        "source drive unplugged. Output goes to the project renders/ folder.",
      inputSchema: {
        version: z.number().int().positive().optional().describe("Timeline version; omit for latest"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    toolHandler(async ({ version }, extra) => {
      const project = getActiveProject();
      const timeline = loadTimeline(project, version);
      const result = await renderTimeline(project, timeline, "preview", progressReporter(extra));
      return ok(
        `Preview rendered: ${result.path}\n` +
          `${result.durationS}s, ${result.width}x${result.height}, ${(result.sizeBytes / 1e6).toFixed(1)} MB. ` +
          `Open it (e.g. QuickTime), then refine with skycut_apply_timeline_edit or finalize with ` +
          `skycut_render_final({ version: ${timeline.version} }).`,
        { ...result, timelineVersion: timeline.version }
      );
    })
  );

  server.registerTool(
    "skycut_render_final",
    {
      title: "Render final",
      description:
        "Full-quality render (HEVC videotoolbox, up to 4K, AAC audio) from the ORIGINAL files on the source drive. " +
        "Requires an explicit timeline version — never renders 'latest' implicitly. The drive must be mounted.",
      inputSchema: {
        version: z.number().int().positive().describe("Timeline version to render (explicit, required)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    toolHandler(async ({ version }, extra) => {
      const project = getActiveProject();
      const timeline = loadTimeline(project, version);
      const result = await renderTimeline(project, timeline, "final", progressReporter(extra));
      return ok(
        `Final render complete: ${result.path}\n` +
          `${result.durationS}s, ${result.width}x${result.height}, ${(result.sizeBytes / 1e6).toFixed(1)} MB (timeline v${version}).`,
        { ...result, timelineVersion: version }
      );
    })
  );
}
