// SkyCut Chat — local MVP web UI for generating and iterating on renders.
// HTTPS on :3080 (dev.ecoworks.ca cert). No auth: local use only.
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

import { getActiveProject, skycutHome } from "../dist/core/project.js";
import { searchMoments } from "../dist/core/analyze.js";
import { proposeCut, DIRECTOR_MODEL } from "../dist/core/director.js";
import {
  loadTimeline,
  listVersions,
  saveTimeline,
  applyEdit,
  validateTimeline,
  validationContextFor,
  summarizeTimeline,
  computeDuration,
} from "../dist/core/timeline.js";
import { renderTimeline } from "../dist/core/render.js";
import { openDb } from "../dist/core/graph.js";

const PORT = 3080;
const RENDER_BASE = "https://dev.ecoworks.ca:5502"; // static file server over ~/SkyCut/projects
const MODEL = "claude-sonnet-4-6";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set — start with the key in env.");
  process.exit(1);
}
const anthropic = new Anthropic({ maxRetries: 4 }); // ride out transient API overloads

// ---- cost tracking (claude-sonnet-4-6: $3/M in, $15/M out, $0.30/M cache read, $3.75/M cache write) ----
const PRICE_PER_M = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const newUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });
const sessionUsage = newUsage();

function addUsage(target, usage) {
  target.input += usage?.input_tokens ?? 0;
  target.output += usage?.output_tokens ?? 0;
  target.cacheRead += usage?.cache_read_input_tokens ?? 0;
  target.cacheWrite += usage?.cache_creation_input_tokens ?? 0;
  target.calls += 1;
}

const usdOf = (u) =>
  (u.input * PRICE_PER_M.input +
    u.output * PRICE_PER_M.output +
    u.cacheRead * PRICE_PER_M.cacheRead +
    u.cacheWrite * PRICE_PER_M.cacheWrite) / 1e6;

/** Director client that meters its API usage into the current turn. */
function meteredDirector(turnUsage) {
  return {
    async complete(system, user) {
      const response = await anthropic.messages.create({
        model: DIRECTOR_MODEL,
        max_tokens: 8192,
        system,
        messages: [{ role: "user", content: user }],
      });
      addUsage(turnUsage, response.usage);
      addUsage(sessionUsage, response.usage);
      return response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    },
  };
}

const renderUrl = (absPath) =>
  `${RENDER_BASE}/${path.relative(path.join(skycutHome(), "projects"), absPath).split(path.sep).join("/")}`;

// ---- tools the chat agent can use ----

const TOOLS = [
  {
    name: "project_status",
    description: "Current project state: clips, segments, timeline versions, renders.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_moments",
    description: "Search the footage graph. Filters: subject, movement (orbit|push-in|pull-back|flyover|pan|static|reveal), min_aesthetic (0-10), stability, exposure, text (free text), limit.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        movement: { type: "string" },
        min_aesthetic: { type: "number" },
        stability: { type: "string" },
        exposure: { type: "string" },
        text: { type: "string" },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "propose_cut",
    description: "AI director builds a new timeline version from the footage graph. Returns the shot list. Does NOT render.",
    input_schema: {
      type: "object",
      properties: {
        brief: { type: "string", description: "Creative brief" },
        duration_s: { type: "number", description: "Target duration seconds (±5%)" },
        style: { type: "string" },
        music_path: { type: "string", description: "Absolute path to a music file" },
      },
      required: ["brief", "duration_s"],
    },
  },
  {
    name: "get_timeline",
    description: "Shot list for a timeline version (latest if omitted), plus the list of all versions.",
    input_schema: { type: "object", properties: { version: { type: "integer" } } },
  },
  {
    name: "apply_timeline_edit",
    description:
      'Apply structured edits to a timeline (latest or base_version), saving a NEW version. Ops: {op:"retrim",id,in_s?,out_s?,speed?}, {op:"remove",id}, {op:"reorder",id,to_index}, {op:"insert",at_index,clip}, {op:"set_transition",id,transition|null}, {op:"set_music",music|null}.',
    input_schema: {
      type: "object",
      properties: {
        edits: { type: "array", items: { type: "object" } },
        base_version: { type: "integer" },
      },
      required: ["edits"],
    },
  },
  {
    name: "render_preview",
    description: "Fast 720p preview render of a timeline version (latest if omitted). Takes ~1-3 minutes.",
    input_schema: { type: "object", properties: { version: { type: "integer" } } },
  },
  {
    name: "render_final",
    description: "Full-quality 4K HEVC render from originals. Requires explicit version and the source drive mounted. Only on user request.",
    input_schema: { type: "object", properties: { version: { type: "integer" } }, required: ["version"] },
  },
];

async function runTool(name, input, emit, turnUsage) {
  const project = getActiveProject();
  switch (name) {
    case "project_status": {
      const db = openDb(project);
      const clips = db.prepare("SELECT COUNT(*) n FROM clips").get().n;
      const segs = db.prepare("SELECT COUNT(*) n FROM segments").get().n;
      db.close();
      const versions = listVersions(project);
      const renders = fs.existsSync(project.paths.renders)
        ? fs.readdirSync(project.paths.renders).filter((f) => f.endsWith(".mp4"))
        : [];
      return (
        `Project '${project.meta.name}': ${clips} clips, ${segs} segments, ` +
        `timelines: ${versions.map((v) => `v${v}`).join(", ") || "none"}, ` +
        `renders: ${renders.map((f) => `${f} → ${renderUrl(path.join(project.paths.renders, f))}`).join(", ") || "none"}.`
      );
    }
    case "search_moments": {
      const rows = searchMoments(project, input ?? {});
      return JSON.stringify(rows.slice(0, 40));
    }
    case "propose_cut": {
      emit({
        type: "status",
        text: `Director is composing a ${input.duration_s}s cut from the footage graph (~30-90s, est. 5-15¢)…`,
      });
      const { timeline, attempts } = await proposeCut(project, meteredDirector(turnUsage), input);
      if (attempts > 1) emit({ type: "status", text: "First draft failed validation — director revised it." });
      return `Saved timeline v${timeline.version}.\n${summarizeTimeline(timeline)}`;
    }
    case "get_timeline": {
      const timeline = loadTimeline(project, input?.version);
      return `${summarizeTimeline(timeline)}\nAll versions: ${listVersions(project).join(", ")}`;
    }
    case "apply_timeline_edit": {
      const ctx = validationContextFor(project);
      let current = loadTimeline(project, input.base_version);
      const summaries = [];
      for (const edit of input.edits) {
        const { result, summary } = applyEdit(current, edit);
        summaries.push(summary);
        current = { ...result, version: current.version };
      }
      const { version: _v, ...body } = current;
      const stamped = { ...body, created: new Date().toISOString() };
      validateTimeline({ ...stamped, version: 999 }, ctx);
      const saved = saveTimeline(project, stamped);
      return `Saved v${saved.version} (${computeDuration(saved).toFixed(1)}s): ${summaries.join("; ")}\n${summarizeTimeline(saved)}`;
    }
    case "render_preview":
    case "render_final": {
      const mode = name === "render_preview" ? "preview" : "final";
      const timeline = loadTimeline(project, input?.version);
      emit({ type: "status", text: `Rendering ${mode} of v${timeline.version} (free — local ffmpeg)…` });
      const t0 = Date.now();
      const result = await renderTimeline(project, timeline, mode, (p, t, m) =>
        emit({ type: "status", text: `[${mode} v${timeline.version}] ${m} (${Math.round((p / t) * 100)}%)` })
      );
      const elapsed_s = Math.round((Date.now() - t0) / 10) / 100;
      emit({
        type: "render",
        url: renderUrl(result.path),
        version: timeline.version,
        mode,
        duration_s: result.durationS,
        size_mb: Math.round(result.sizeBytes / 1e5) / 10,
        elapsed_s,
      });
      return `${mode} of v${timeline.version} rendered in ${elapsed_s}s: ${result.durationS}s, ${(result.sizeBytes / 1e6).toFixed(1)} MB, URL: ${renderUrl(result.path)}`;
    }
    default:
      return `Unknown tool ${name}`;
  }
}

const SYSTEM = `You are SkyCut's chat assistant — you help the user create and iterate on video cuts from their analyzed drone footage, conversationally.

Workflow you drive with tools: search/explore the footage graph → propose_cut (new timeline version) → render_preview → user watches → apply_timeline_edit for revisions (each edit = new version) → render_preview again → render_final only when the user explicitly asks to finalize.

Rules:
- Timeline versions are immutable; edits create new versions. The user can have several cuts in flight — track versions carefully and always say which version you acted on.
- Always render_preview after proposing or editing unless the user says not to.
- Never call render_final unless the user explicitly asks for a final render of a specific version.
- Be concise. The UI shows renders as embedded videos automatically — don't paste URLs into your reply.
- If a request is impossible (duration too long for the footage, unknown version), explain briefly and suggest what would work.`;

// ---- conversation state (single local session, reset via /api/reset) ----
let history = [];
let turnQueue = Promise.resolve(); // turns are strictly serialized — concurrent SSE requests queue up

/** Drop everything from the first assistant tool_use that lacks its tool_result reply. */
function sanitizeHistory() {
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const toolIds = msg.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    if (toolIds.length === 0) continue;
    const next = history[i + 1];
    const resultIds = new Set(
      next?.role === "user" && Array.isArray(next.content)
        ? next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)
        : []
    );
    if (!toolIds.every((id) => resultIds.has(id))) {
      history.length = i; // truncate the broken tail — the session stays usable
      return;
    }
  }
}

async function chatTurn(userMessage, emit) {
  // Transactional: a turn that dies mid-tool-call must not leave a dangling
  // tool_use in history (it would 400 every subsequent API call).
  sanitizeHistory();
  const checkpoint = history.length;
  try {
    await runTurn(userMessage, emit);
  } catch (err) {
    history.length = checkpoint;
    throw err;
  }
}

async function runTurn(userMessage, emit) {
  history.push({ role: "user", content: userMessage });
  const turnUsage = newUsage();
  const emitCost = () =>
    emit({
      type: "cost",
      turn_usd: Math.round(usdOf(turnUsage) * 1000) / 1000,
      session_usd: Math.round(usdOf(sessionUsage) * 1000) / 1000,
      turn_in: turnUsage.input + turnUsage.cacheRead + turnUsage.cacheWrite,
      turn_out: turnUsage.output,
      api_calls: turnUsage.calls,
    });

  for (let turn = 0; turn < 20; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      tools: TOOLS,
      messages: history,
    });
    addUsage(turnUsage, response.usage);
    addUsage(sessionUsage, response.usage);
    history.push({ role: "assistant", content: response.content });

    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (text.trim()) emit({ type: "text", text });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0 || response.stop_reason !== "tool_use") {
      emitCost();
      return;
    }

    const results = [];
    for (const tu of toolUses) {
      emit({ type: "tool", name: tu.name, input: tu.input });
      let content;
      let isError = false;
      try {
        content = await runTool(tu.name, tu.input, emit, turnUsage);
      } catch (err) {
        content = String(err?.message ?? err);
        isError = true;
        emit({ type: "status", text: `Error in ${tu.name}: ${content}` });
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content, is_error: isError });
    }
    history.push({ role: "user", content: results });
  }
  emitCost();
  emit({ type: "text", text: "(stopped: too many steps in one turn — ask me to continue)" });
}

// ---- HTTPS server ----
const certDir = path.join(os.homedir(), "Code/.traefik/certs");
const server = https.createServer(
  { cert: fs.readFileSync(path.join(certDir, "cert.pem")), key: fs.readFileSync(path.join(certDir, "key.pem")) },
  async (req, res) => {
    const { pathname } = new URL(req.url, "https://x");
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    } else if (req.method === "GET" && pathname === "/api/renders") {
      try {
        const project = getActiveProject();
        const renders = fs
          .readdirSync(project.paths.renders)
          .filter((f) => f.endsWith(".mp4"))
          .map((f) => {
            const abs = path.join(project.paths.renders, f);
            const m = /-v(\d+)-(preview|final)\.mp4$/.exec(f);
            return {
              url: renderUrl(abs),
              file: f,
              version: m ? Number(m[1]) : null,
              mode: m ? m[2] : "unknown",
              size_mb: Math.round(fs.statSync(abs).size / 1e5) / 10,
              mtime: fs.statSync(abs).mtimeMs,
            };
          })
          .sort((a, b) => b.mtime - a.mtime);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ project: project.meta.name, renders }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      }
    } else if (req.method === "POST" && pathname === "/api/reset") {
      history = [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    } else if (req.method === "POST" && pathname === "/api/chat") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const { message } = JSON.parse(body || "{}");
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // emit must never throw (client may disconnect mid-render); the work continues regardless.
        const emit = (event) => {
          if (event.type !== "ping") console.log(`[${new Date().toISOString()}] ${event.type}: ${(event.text ?? event.name ?? event.url ?? "").toString().slice(0, 140)}`);
          try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {
            /* stream gone — renders still land in /api/renders */
          }
        };
        const heartbeat = setInterval(() => emit({ type: "ping" }), 15000);
        // Strict serialization: a second message waits for the in-flight turn instead of
        // interleaving writes into the shared history.
        const myTurn = turnQueue.then(async () => {
          try {
            await chatTurn(String(message ?? ""), emit);
          } catch (err) {
            emit({ type: "text", text: `Server error: ${err?.message ?? err}` });
          }
        });
        turnQueue = myTurn;
        await myTurn;
        clearInterval(heartbeat);
        emit({ type: "done" });
        res.end();
      });
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  }
);

server.listen(PORT, () => console.log(`SkyCut Chat: https://dev.ecoworks.ca:${PORT}`));
