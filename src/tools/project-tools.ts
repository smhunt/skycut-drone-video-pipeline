import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initProject, listVolumes } from "../core/project.js";
import { toolHandler, ok } from "./util.js";

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "skycut_init_project",
    {
      title: "Initialize project",
      description:
        "Create (or reopen) a SkyCut project for a folder of source footage and make it the active project. " +
        "The source path is treated as READ-ONLY; all derived files go to the workspace under ~/SkyCut/projects/. " +
        'Example: skycut_init_project({ source_path: "/Volumes/DJI/ogoki-lodge" })',
      inputSchema: {
        source_path: z
          .string()
          .describe('Absolute path to the folder of raw footage, e.g. "/Volumes/DJI/lodge-trip"'),
        name: z
          .string()
          .optional()
          .describe("Project name (defaults to the folder name); slugified for the workspace directory"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    toolHandler(async ({ source_path, name }) => {
      const project = initProject(source_path, name);
      return ok(
        `Project '${project.meta.name}' (slug: ${project.meta.slug}) is now active.\n` +
          `Source (read-only): ${project.meta.sourcePath}\n` +
          `Workspace: ${project.paths.root}\n` +
          `Next: skycut_scan_footage() to index clips and build proxies.`,
        { ...project.meta, workspace: project.paths.root }
      );
    })
  );

  server.registerTool(
    "skycut_list_volumes",
    {
      title: "List mounted volumes",
      description:
        "List volumes under /Volumes with free/total space (GB), to help pick the source drive for skycut_init_project.",
      annotations: { readOnlyHint: true },
    },
    toolHandler(async () => {
      const volumes = listVolumes();
      if (volumes.length === 0) return ok("No external volumes mounted under /Volumes.", { volumes });
      const lines = volumes.map((v) =>
        Number.isNaN(v.freeGb) ? `${v.path} (size unknown)` : `${v.path} — ${v.freeGb} GB free of ${v.totalGb} GB`
      );
      return ok(lines.join("\n"), { volumes });
    })
  );
}
