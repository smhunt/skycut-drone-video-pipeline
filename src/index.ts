#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { checkDependencies, formatDepIssues } from "./core/deps.js";
import { registerAllTools } from "./tools/index.js";

// stdio transport owns stdout — all human-facing logging goes to stderr.
const log = (msg: string) => console.error(`[skycut] ${msg}`);

async function main() {
  const deps = await checkDependencies();
  if (!deps.ok) {
    for (const issue of formatDepIssues(deps)) log(`WARN ${issue}`);
    log("Starting anyway — tools that need missing dependencies will return errors.");
  }

  const server = new McpServer({ name: "skycut", version: "0.1.0" });
  registerAllTools(server, deps);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("SkyCut MCP server running (stdio)");
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
