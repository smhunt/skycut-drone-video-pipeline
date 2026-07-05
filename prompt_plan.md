# SkyCut — AI Video Assembly MCP Server (MVP)
### One-shot execution plan for Claude Code
Working name `skycut` — rename freely. This file is the complete spec: read it fully, then execute phases in order. Maintain `progress.md` after every phase. Small, reviewable commits — one per phase minimum. Plan-first applies *within* phases only if something here proves wrong; otherwise do not stop to re-plan.

---

## 1. Mission

Build a **local-first MCP server (stdio, TypeScript)** that turns a folder of raw drone footage into a polished marketing cut through an agent workflow:

**scan → analyze (vision) → footage graph → propose cut → human approve → render**

**MVP demo:** point it at a USB folder of raw drone video of a fly-in fishing lodge and produce a 60–90 second marketing edit with crossfades and an optional music bed, driven conversationally from Claude Code / Claude Desktop.

## 2. Environment & hard constraints

- **Host:** MacBook Pro M1 Max, 64 GB RAM, macOS. All processing local.
- **Source footage:** external USB drive, e.g. `/Volumes/<drive>/<folder>`. Path is **selected at startup** (see §5, `init_project`). 
- **Treat the USB source as READ-ONLY.** Never write, move, rename, or delete anything under the source path. All derived artifacts go to the internal SSD workspace.
- **Workspace:** `~/SkyCut/projects/<project-slug>/` (manifest, proxies, frames, footage graph, timelines, renders, logs).
- **Dependencies:** Node 20+, ffmpeg + ffprobe (`brew install ffmpeg`), `ANTHROPIC_API_KEY` in env for vision analysis and cut proposal. Verify all three at startup with actionable error messages.
- **Hardware encoding:** use `h264_videotoolbox` / `hevc_videotoolbox` for all renders (Apple Silicon). CRF-style quality via `-q:v`.
- **Resilience:** USB drives disconnect. Every tool that touches source files must check the path exists and return a clear "drive not mounted — reconnect and retry" error rather than crash. Proxies mean most work continues without the drive.
- Never delete the workspace or caches without explicit user confirmation.

## 3. Repo scaffold (Phase 0)

```
skycut/
  package.json  tsconfig.json  .gitignore  README.md  progress.md
  src/
    index.ts            # MCP server entry (stdio)
    tools/              # one file per tool
    core/
      project.ts        # workspace + manifest management
      ffmpeg.ts         # ffprobe/ffmpeg wrappers (execa)
      frames.ts         # keyframe sampling
      vision.ts         # Claude API batch frame analysis
      graph.ts          # footage graph (SQLite via better-sqlite3)
      timeline.ts       # schema (zod), validation, diffing
      render.ts         # preview + final render pipelines
      director.ts       # propose_cut — Claude API call w/ footage graph
    schemas/timeline.ts # zod source of truth (§6)
  eval/questions.xml    # Phase 8
```

Stack: TypeScript, `@modelcontextprotocol/sdk` (stdio transport), `zod`, `better-sqlite3`, `execa`, `@anthropic-ai/sdk`. No Python. Fetch the TS SDK README and MCP best practices before writing server code.

## 4. Pipeline design

### 4.1 Scan (`scan_footage`)
- Recursively find video files under source path (`.mp4 .mov .mts .mkv`, case-insensitive). Ignore hidden/AppleDouble (`._*`) files.
- `ffprobe` each: duration, resolution, fps, codec, bitrate, creation time, GPS/telemetry metadata if present (DJI often embeds).
- Write `manifest.json`; insert clips into SQLite `clips` table with a stable `clip_id` (hash of relative path + size).
- Generate **720p proxies** (videotoolbox, ~5 Mbps) into `proxies/` — skip if already present (idempotent). Proxies are what previews render from.

### 4.2 Analyze (`analyze_footage`)
Drone clips are typically single continuous shots — do NOT rely on scene-cut detection. Instead:
- Sample keyframes every **4 seconds** per clip (ffmpeg `-vf fps=1/4`, scaled to 768px wide JPEG, quality ~80) into `frames/<clip_id>/`.
- Batch frames to Claude (`claude-sonnet-4-6`, vision) — up to 8 frames per request with timestamps in the prompt. System prompt instructs JSON-only output per frame:
  ```json
  { "t": 12.0, "subjects": ["lodge","dock","shoreline"], "movement": "orbit|push-in|pull-back|flyover|pan|static|reveal",
    "quality": {"exposure":"good|over|under","horizon":"level|tilted","stability":"smooth|jittery"},
    "aesthetic": 0-10, "notes": "golden light on lodge roofline" }
  ```
- Post-process into **segments**: merge consecutive frames with same subjects+movement into scored segments (`segments` table: clip_id, t_in, t_out, subjects, movement, avg aesthetic, flags). This is the footage graph.
- Cache aggressively: skip clips already analyzed (hash check). Log API cost estimate (frame count × ~1.2k tokens) before running; if > 500 frames, report the count and proceed only after user confirmation via tool response.

### 4.3 Direct (`propose_cut`)
- Input: brief (e.g. "90s marketing cut for a fly-in fishing lodge, cinematic, slow build to reveal"), target duration, style hints, optional music file.
- Implementation: single Claude API call. Context = compact footage graph (segments table as JSON, top ~150 segments by aesthetic score). Instructions: build a narrative arc (establish → reveal → activity → beauty shots → closing), prefer smooth/level/good-exposure segments, vary movement types, clip lengths 3–8 s, land within ±5% of target duration, output **only** a valid timeline JSON per §6.
- Validate output against the zod schema; on failure, one retry with the validation errors appended. Save as `timelines/v<N>.json` — **never auto-render final**; return the timeline summary for human review.

### 4.4 Revise (`apply_timeline_edit`)
- Accepts either a full replacement timeline or a structured diff (`insert/remove/reorder/retrim/set_transition/set_music`). Validates, saves as new version, returns human-readable change summary. Versions are immutable — edits always create `v<N+1>`.

### 4.5 Render (`render_preview`, `render_final`)
- **Preview:** from proxies, 720p, videotoolbox, fast. Target: <60 s render for a 90 s cut on M1 Max.
- **Final:** from originals on the USB drive (check mounted), up to source resolution (cap 4K), HEVC videotoolbox high quality + AAC audio.
- Assembly: per-clip trim to intermediate segments (stream-accurate, re-encode), then `xfade` chain for crossfades (default 0.75 s) and `concat`. Music: loop/trim to duration, 2 s fade-out, ~-18 LUFS under (no dialogue expected; if clip audio exists, drop it by default — drone audio is rotor noise).
- Output to `renders/` with timeline version in filename. Return absolute path + duration + file size.

## 5. MCP tool surface

All tools: zod input schemas with descriptions + examples, `structuredContent` outputs, annotations (`readOnlyHint` etc.), actionable errors. Prefix: `skycut_`.

| Tool | Purpose | Annotations |
|---|---|---|
| `skycut_init_project(source_path, name?)` | Validate path (must exist, list `/Volumes` in the error if not), create workspace, set active project | not read-only |
| `skycut_list_volumes()` | List `/Volumes/*` with free space to help pick the drive | read-only |
| `skycut_scan_footage()` | §4.1; returns clip count, total duration, proxy progress | idempotent |
| `skycut_analyze_footage(force?)` | §4.2; returns segment count, cost estimate, top subjects | idempotent |
| `skycut_search_moments(query)` | Query footage graph by subject/movement/quality/score (SQL-backed filters + free text against notes) | read-only |
| `skycut_propose_cut(brief, duration_s, style?, music_path?)` | §4.3; returns timeline version + shot list summary | not destructive |
| `skycut_get_timeline(version?)` | Return timeline JSON + summary | read-only |
| `skycut_apply_timeline_edit(edit)` | §4.4 | not destructive (versioned) |
| `skycut_render_preview(version?)` | 720p proxy render | not destructive |
| `skycut_render_final(version)` | Full-res render; requires explicit version arg | not destructive |
| `skycut_project_status()` | Pipeline state: scanned? analyzed? timelines? renders? drive mounted? | read-only |

## 6. Timeline schema (source of truth — implement in zod)

```jsonc
{
  "version": 3,
  "project": "ogoki-lodge",
  "created": "2026-07-05T21:00:00Z",
  "output": { "width": 3840, "height": 2160, "fps": 29.97 },
  "music": { "path": "/Users/sean/SkyCut/music/bed.mp3", "gain_db": -6, "fade_out_s": 2 },
  "clips": [
    {
      "id": "c1",
      "clip_id": "a1b2c3",           // FK into footage graph
      "in_s": 42.0, "out_s": 48.5,   // source timecodes
      "speed": 1.0,                   // 0.25–4.0
      "transition_out": { "type": "xfade", "style": "fade", "duration_s": 0.75 },
      "label": "golden-hour lodge reveal, push-in"
    }
  ],
  "text_overlays": [
    { "text": "Ogoki Reservoir Lodge", "t_in": 2.0, "t_out": 6.0, "position": "lower-third", "size": "large" }
  ]
}
```

Validation rules: `out_s > in_s`; timecodes within clip duration; computed total (clip lengths minus transition overlaps) within ±5% of any requested target; every `clip_id` exists in manifest.

## 7. Execution phases & commit checkpoints

| # | Phase | Done when |
|---|---|---|
| 0 | Scaffold + dep checks + `progress.md` | `npm run build` clean; server boots and lists tools in MCP Inspector |
| 1 | Project/workspace + `init_project`, `list_volumes` | Init against a test folder creates workspace + registers project |
| 2 | Scan + proxies | Manifest + SQLite rows + proxies for sample clips (create 2–3 tiny test clips with ffmpeg `testsrc` if no real footage available in CI) |
| 3 | Analysis pipeline | Frames sampled; vision call mocked in tests, live behind API key; segments in DB |
| 4 | Timeline engine | Schema, validation, versioning, diff edits — unit tested |
| 5 | Render pipelines | Preview renders a valid multi-clip xfade cut from test clips |
| 6 | Director (`propose_cut`) | Valid timeline generated from a synthetic footage graph fixture |
| 7 | Wire-up + README | Full happy path via MCP Inspector; README covers Claude Code + Claude Desktop stdio config |
| 8 | Evals | 10 read-only Q&A pairs in `eval/questions.xml` against the synthetic fixture |

## 8. Acceptance test (the demo)

1. `skycut_init_project("/Volumes/<drive>/<lodge-folder>")`
2. `skycut_scan_footage()` → N clips, total duration reported
3. `skycut_analyze_footage()` → segments + top subjects (expect: lodge, water, shoreline, dock, aircraft)
4. `skycut_propose_cut("Cinematic 90-second marketing cut for a fly-in fishing lodge. Slow aerial build, reveal the lodge at golden hour, end on a wide sunset pull-back.", 90)`
5. Review shot list → `skycut_render_preview()` → watch → one `apply_timeline_edit` revision → `skycut_render_final(v2)`
6. Output plays in QuickTime, ~90 s, smooth crossfades, music bed if provided.

## 9. Guardrails (non-negotiable)

- USB source is read-only. Workspace deletions require explicit confirmation. No Docker involved, but the same rule applies to any cleanup: ask first.
- Final renders only via explicit `render_final` with a named version — the agent never auto-finalizes.
- Log every ffmpeg command to `logs/` for debuggability.
- Update `progress.md` at each phase boundary: what shipped, what's next, any deviations from this plan and why.
