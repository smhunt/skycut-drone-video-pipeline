import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getActiveProject } from "../core/project.js";
import { scanFootage } from "../core/scan.js";
import { toolHandler, ok, progressReporter, type ToolExtra } from "./util.js";

export function registerScanTools(server: McpServer): void {
  server.registerTool(
    "skycut_scan_footage",
    {
      title: "Scan footage",
      description:
        "Recursively index video files (.mp4/.mov/.mts/.mkv) under the active project's source path: " +
        "ffprobe metadata into the footage database + manifest.json, and build 720p proxies for previews. " +
        "Idempotent — re-running skips clips and proxies that already exist. The source is never modified.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    toolHandler(async (extra: ToolExtra) => {
      const project = getActiveProject();
      const result = await scanFootage(project, progressReporter(extra));
      const mins = (result.totalDurationS / 60).toFixed(1);
      let text =
        `Scanned ${result.clipCount} clips (${mins} min total). ` +
        `${result.newClips} new, proxies: ${result.proxiesBuilt} built / ${result.proxiesSkipped} already present.`;
      if (result.errors.length) {
        text += `\n${result.errors.length} file(s) failed:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
      }
      text += `\nNext: skycut_analyze_footage() to build the footage graph.`;
      return ok(text, { ...result });
    })
  );
}
