import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DepStatus } from "../core/deps.js";
import { registerHealthTool } from "./health.js";
import { registerProjectTools } from "./project-tools.js";

export function registerAllTools(server: McpServer, deps: DepStatus): void {
  registerHealthTool(server, deps);
  registerProjectTools(server);
}
