import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { UserError, driveNotMountedError } from "./errors.js";

/** Root for all SkyCut state. Overridable for tests. */
export function skycutHome(): string {
  return process.env.SKYCUT_HOME ?? path.join(os.homedir(), "SkyCut");
}

export interface ProjectMeta {
  name: string;
  slug: string;
  sourcePath: string;
  created: string;
}

export interface ProjectPaths {
  root: string;
  projectJson: string;
  manifest: string;
  db: string;
  proxies: string;
  frames: string;
  timelines: string;
  renders: string;
  logs: string;
}

export interface Project {
  meta: ProjectMeta;
  paths: ProjectPaths;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new UserError(`Cannot derive a project slug from name: ${JSON.stringify(name)}`);
  return slug;
}

export function projectPaths(slug: string): ProjectPaths {
  const root = path.join(skycutHome(), "projects", slug);
  return {
    root,
    projectJson: path.join(root, "project.json"),
    manifest: path.join(root, "manifest.json"),
    db: path.join(root, "footage.db"),
    proxies: path.join(root, "proxies"),
    frames: path.join(root, "frames"),
    timelines: path.join(root, "timelines"),
    renders: path.join(root, "renders"),
    logs: path.join(root, "logs"),
  };
}

const activePointerPath = () => path.join(skycutHome(), "active-project.json");

export function initProject(sourcePath: string, name?: string): Project {
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) {
    let volumes: string[] = [];
    try {
      volumes = fs.readdirSync("/Volumes").filter((v) => !v.startsWith("."));
    } catch {
      /* /Volumes unreadable — omit the hint */
    }
    throw new UserError(
      `Source path does not exist: ${resolved}\n` +
        (volumes.length
          ? `Mounted volumes: ${volumes.map((v) => `/Volumes/${v}`).join(", ")}`
          : `No volumes visible under /Volumes.`)
    );
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new UserError(`Source path is not a directory: ${resolved}`);
  }

  const projectName = name ?? path.basename(resolved);
  const slug = slugify(projectName);
  const paths = projectPaths(slug);

  for (const dir of [paths.root, paths.proxies, paths.frames, paths.timelines, paths.renders, paths.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let meta: ProjectMeta;
  if (fs.existsSync(paths.projectJson)) {
    // Re-init of an existing project: keep identity, allow the source path to move (drive letter changes).
    meta = JSON.parse(fs.readFileSync(paths.projectJson, "utf8")) as ProjectMeta;
    meta.sourcePath = resolved;
  } else {
    meta = { name: projectName, slug, sourcePath: resolved, created: new Date().toISOString() };
  }
  fs.writeFileSync(paths.projectJson, JSON.stringify(meta, null, 2));
  fs.writeFileSync(activePointerPath(), JSON.stringify({ slug }, null, 2));

  return { meta, paths };
}

export function getActiveProject(): Project {
  const pointer = activePointerPath();
  if (!fs.existsSync(pointer)) {
    throw new UserError("No active project. Run skycut_init_project(source_path) first.");
  }
  const { slug } = JSON.parse(fs.readFileSync(pointer, "utf8")) as { slug: string };
  const paths = projectPaths(slug);
  if (!fs.existsSync(paths.projectJson)) {
    throw new UserError(
      `Active project '${slug}' is missing its workspace (${paths.root}). Run skycut_init_project again.`
    );
  }
  const meta = JSON.parse(fs.readFileSync(paths.projectJson, "utf8")) as ProjectMeta;
  return { meta, paths };
}

/** Throw a clear error if the USB source is not currently reachable. */
export function assertSourceMounted(project: Project): void {
  if (!fs.existsSync(project.meta.sourcePath)) {
    throw driveNotMountedError(project.meta.sourcePath);
  }
}

export function isSourceMounted(project: Project): boolean {
  return fs.existsSync(project.meta.sourcePath);
}

export interface VolumeInfo {
  path: string;
  freeGb: number;
  totalGb: number;
}

export function listVolumes(): VolumeInfo[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync("/Volumes").filter((v) => !v.startsWith("."));
  } catch {
    return [];
  }
  const volumes: VolumeInfo[] = [];
  for (const entry of entries) {
    const p = path.join("/Volumes", entry);
    try {
      const s = fs.statfsSync(p);
      volumes.push({
        path: p,
        freeGb: Math.round(((s.bavail * s.bsize) / 1e9) * 10) / 10,
        totalGb: Math.round(((s.blocks * s.bsize) / 1e9) * 10) / 10,
      });
    } catch {
      volumes.push({ path: p, freeGb: NaN, totalGb: NaN });
    }
  }
  return volumes;
}
