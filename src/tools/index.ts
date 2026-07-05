import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DepStatus } from "../core/deps.js";
import { registerHealthTool } from "./health.js";
import { registerProjectTools } from "./project-tools.js";
import { registerScanTools } from "./scan-tools.js";
import { registerAnalyzeTools } from "./analyze-tools.js";
import { registerTimelineTools } from "./timeline-tools.js";
import { registerRenderTools } from "./render-tools.js";
import { registerDirectorTools } from "./director-tools.js";
import { registerStatusTools } from "./status-tools.js";

export function registerAllTools(server: McpServer, deps: DepStatus): void {
  registerHealthTool(server, deps);
  registerProjectTools(server);
  registerScanTools(server);
  registerAnalyzeTools(server);
  registerTimelineTools(server);
  registerRenderTools(server);
  registerDirectorTools(server);
  registerStatusTools(server);
}
