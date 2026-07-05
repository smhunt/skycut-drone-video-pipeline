import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Project } from "../core/project.js";
import { openDb } from "../core/graph.js";
import { searchMoments, topSubjects, type MomentQuery } from "../core/analyze.js";
import { createSyntheticProject, destroySyntheticProject } from "./synthetic.js";

let fixture: { project: Project; home: string; source: string };

beforeAll(() => {
  fixture = createSyntheticProject();
});
afterAll(() => destroySyntheticProject(fixture));

interface Qa {
  id: string;
  question: string;
  op: string;
  args: Record<string, unknown>;
  expected: string;
}

function loadQas(): Qa[] {
  const xml = fs.readFileSync(path.join(process.cwd(), "eval/questions.xml"), "utf8");
  const qas: Qa[] = [];
  const qaRe = /<qa id="(\d+)">([\s\S]*?)<\/qa>/g;
  const field = (block: string, tag: string) =>
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1].trim() ?? "";
  let m: RegExpExecArray | null;
  while ((m = qaRe.exec(xml))) {
    qas.push({
      id: m[1],
      question: field(m[2], "question"),
      op: field(m[2], "op"),
      args: JSON.parse(field(m[2], "args")),
      expected: field(m[2], "expected"),
    });
  }
  return qas;
}

function runOp(op: string, args: Record<string, unknown>): string {
  const project = fixture.project;
  switch (op) {
    case "clip_count":
    case "segment_count":
    case "total_duration":
    case "top_subject":
    case "exposure_problem_count": {
      const db = openDb(project);
      try {
        if (op === "clip_count") return String((db.prepare("SELECT COUNT(*) n FROM clips").get() as { n: number }).n);
        if (op === "segment_count")
          return String((db.prepare("SELECT COUNT(*) n FROM segments").get() as { n: number }).n);
        if (op === "total_duration")
          return String((db.prepare("SELECT SUM(duration_s) s FROM clips").get() as { s: number }).s);
        if (op === "exposure_problem_count")
          return String(
            (db.prepare("SELECT COUNT(*) n FROM segments WHERE exposure != 'good'").get() as { n: number }).n
          );
        return topSubjects(db, 1)[0].subject;
      } finally {
        db.close();
      }
    }
    case "search_count":
      return String(searchMoments(project, args as MomentQuery).length);
    case "search_top": {
      const top = searchMoments(project, args as MomentQuery)[0];
      return top ? `clip=${top.clip_id} t_in=${top.t_in} aesthetic=${top.avg_aesthetic} notes=${top.notes}` : "none";
    }
    default:
      throw new Error(`Unknown eval op: ${op}`);
  }
}

describe("eval/questions.xml", () => {
  const qas = loadQas();

  it("contains exactly 10 Q&A pairs", () => {
    expect(qas).toHaveLength(10);
  });

  for (const qa of qas) {
    it(`Q${qa.id}: ${qa.question}`, () => {
      const actual = runOp(qa.op, qa.args);
      // expected is either an exact value or a "key=value key2~substring" spec
      if (!qa.expected.includes("=")) {
        expect(actual).toBe(qa.expected);
        return;
      }
      for (const part of qa.expected.split(/\s+(?=\w+[=~])/)) {
        const eq = /^(\w+)=(\S+)/.exec(part);
        const like = /^(\w+)~(.+)$/.exec(part);
        if (eq) expect(actual).toContain(`${eq[1]}=${eq[2]}`);
        else if (like) expect(actual.toLowerCase()).toContain(like[2].toLowerCase());
      }
    });
  }
});
