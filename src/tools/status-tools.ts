import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getActiveProject, isSourceMounted } from "../core/project.js";
import { openDb } from "../core/graph.js";
import { listVersions } from "../core/timeline.js";
import { toolHandler, ok } from "./util.js";
import { UserError } from "../core/errors.js";

export function registerStatusTools(server: McpServer): void {
  server.registerTool(
    "skycut_project_status",
    {
      title: "Project status",
      description:
        "Pipeline state for the active project: scan/analysis progress, timeline versions, renders, and whether " +
        "the source drive is currently mounted.",
      annotations: { readOnlyHint: true },
    },
    toolHandler(async () => {
      let project;
      try {
        project = getActiveProject();
      } catch (err) {
        if (err instanceof UserError) return ok(`No active project. ${err.message}`, { active: false });
        throw err;
      }

      const mounted = isSourceMounted(project);
      const db = openDb(project);
      let clipCount = 0;
      let analyzedCount = 0;
      let segmentCount = 0;
      let proxyCount = 0;
      try {
        clipCount = (db.prepare("SELECT COUNT(*) n FROM clips").get() as { n: number }).n;
        analyzedCount = (db.prepare("SELECT COUNT(*) n FROM clips WHERE analyzed = 1").get() as { n: number }).n;
        segmentCount = (db.prepare("SELECT COUNT(*) n FROM segments").get() as { n: number }).n;
        proxyCount = (
          db.prepare("SELECT COUNT(*) n FROM clips WHERE proxy_path IS NOT NULL").get() as { n: number }
        ).n;
      } finally {
        db.close();
      }

      const versions = listVersions(project);
      const renders = fs.existsSync(project.paths.renders)
        ? fs.readdirSync(project.paths.renders).filter((f) => f.endsWith(".mp4"))
        : [];

      const nextStep =
        clipCount === 0
          ? "skycut_scan_footage()"
          : analyzedCount < clipCount
            ? "skycut_analyze_footage()"
            : versions.length === 0
              ? "skycut_propose_cut(brief, duration_s)"
              : "skycut_render_preview() / skycut_apply_timeline_edit / skycut_render_final(version)";

      const text = [
        `Project: ${project.meta.name} (${project.meta.slug})`,
        `Source: ${project.meta.sourcePath} — ${mounted ? "MOUNTED" : "NOT MOUNTED (proxies still work for previews)"}`,
        `Scanned: ${clipCount} clips (${proxyCount} proxies) | Analyzed: ${analyzedCount}/${clipCount} clips, ${segmentCount} segments`,
        `Timelines: ${versions.length ? versions.map((v) => `v${v}`).join(", ") : "none"}`,
        `Renders: ${renders.length ? renders.join(", ") : "none"}`,
        `Suggested next step: ${nextStep}`,
      ].join("\n");

      return ok(text, {
        active: true,
        project: project.meta,
        sourceMounted: mounted,
        clipCount,
        proxyCount,
        analyzedCount,
        segmentCount,
        timelineVersions: versions,
        renders: renders.map((f) => path.join(project.paths.renders, f)),
      });
    })
  );
}
