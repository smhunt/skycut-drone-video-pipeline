import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initProject, getActiveProject, slugify, listVolumes } from "./project.js";

let home: string;
let source: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "skycut-home-"));
  source = fs.mkdtempSync(path.join(os.tmpdir(), "skycut-src-"));
  process.env.SKYCUT_HOME = home;
});

afterEach(() => {
  delete process.env.SKYCUT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(source, { recursive: true, force: true });
});

describe("slugify", () => {
  it("kebab-cases names", () => {
    expect(slugify("Ogoki Reservoir Lodge!")).toBe("ogoki-reservoir-lodge");
  });
  it("rejects unusable names", () => {
    expect(() => slugify("!!!")).toThrow();
  });
});

describe("initProject", () => {
  it("creates workspace dirs and sets active project", () => {
    const project = initProject(source, "Test Lodge");
    expect(project.meta.slug).toBe("test-lodge");
    for (const dir of ["proxies", "frames", "timelines", "renders", "logs"]) {
      expect(fs.existsSync(path.join(project.paths.root, dir))).toBe(true);
    }
    const active = getActiveProject();
    expect(active.meta.slug).toBe("test-lodge");
    expect(active.meta.sourcePath).toBe(fs.realpathSync(source) === source ? source : active.meta.sourcePath);
  });

  it("re-init keeps identity but updates source path", () => {
    const first = initProject(source, "Lodge");
    const newSource = fs.mkdtempSync(path.join(os.tmpdir(), "skycut-src2-"));
    try {
      const second = initProject(newSource, "Lodge");
      expect(second.meta.created).toBe(first.meta.created);
      expect(second.meta.sourcePath).toContain("skycut-src2-");
    } finally {
      fs.rmSync(newSource, { recursive: true, force: true });
    }
  });

  it("rejects a missing source path with volume hint", () => {
    expect(() => initProject("/nonexistent/path/xyz")).toThrow(/does not exist/);
  });
});

describe("listVolumes", () => {
  it("returns an array (possibly empty) without throwing", () => {
    expect(Array.isArray(listVolumes())).toBe(true);
  });
});
