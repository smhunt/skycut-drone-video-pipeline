import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkDependencies, formatDepIssues, type DepStatus } from "../core/deps.js";

export function registerHealthTool(server: McpServer, startupDeps: DepStatus): void {
  server.registerTool(
    "skycut_health",
    {
      title: "SkyCut health check",
      description:
        "Report status of required dependencies (Node, ffmpeg, ffprobe, videotoolbox encoders, ANTHROPIC_API_KEY). " +
        "Run this first if any other tool returns unexpected errors.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const deps = await checkDependencies();
      const issues = formatDepIssues(deps);
      return {
        content: [
          {
            type: "text",
            text: deps.ok
              ? "All dependencies OK."
              : `Issues found:\n${issues.map((i) => `- ${i}`).join("\n")}`,
          },
        ],
        structuredContent: { ...deps, startupOk: startupDeps.ok },
      };
    }
  );
}
