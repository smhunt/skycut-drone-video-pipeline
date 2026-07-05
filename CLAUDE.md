# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**SkyCut** — a local-first MCP server (stdio, TypeScript) that converts raw drone footage into polished marketing video cuts via an agent-driven pipeline: scan → analyze (vision) → footage graph → propose cut → human approve → render.

**`prompt_plan.md` is the authoritative spec — read it fully before writing code.** The repo may be greenfield (spec only); if `progress.md` exists it records which build phases have shipped. Execute phases in order, one commit per phase minimum, and update `progress.md` at every phase boundary.

## Commands

Defined at Phase 0 scaffold (check `package.json` for the current set):

```bash
npm run build       # compile TypeScript — must be clean before a phase counts as done
node dist/index.js  # run the MCP server (stdio transport)
npm test            # unit tests (vision calls mocked; live only behind ANTHROPIC_API_KEY)
```

Verify the server boots and lists tools with MCP Inspector: `npx @modelcontextprotocol/inspector node dist/index.js`

## Architecture (planned in spec §3)

```
src/
  index.ts            # MCP server entry — stdio transport, registers all tools
  tools/              # one file per skycut_* MCP tool
  core/
    project.ts        # workspace + manifest management (~/.SkyCut/projects/<slug>/)
    ffmpeg.ts         # ffprobe/ffmpeg wrappers via execa
    frames.ts         # keyframe sampling (1 frame/4s, 768px JPEG)
    vision.ts         # Claude API batch frame analysis (claude-sonnet-4-6)
    graph.ts          # footage graph — SQLite via better-sqlite3
    timeline.ts       # schema (zod), validation, versioning, diffing
    render.ts         # preview (proxy, 720p) + final (USB source, 4K) pipelines
    director.ts       # propose_cut — single Claude API call with footage graph
  schemas/timeline.ts # zod source of truth for timeline JSON
eval/questions.xml    # Phase 8 evals (10 Q&A pairs against synthetic fixture)
```

**Workspace layout** (on internal SSD, never the USB source):
```
~/SkyCut/projects/<project-slug>/
  manifest.json     # clip registry
  footage.db        # SQLite: clips, segments tables
  proxies/          # 720p H.264 proxy files (~5 Mbps)
  frames/<clip_id>/ # keyframe JPEGs for vision analysis
  timelines/        # v1.json, v2.json … (immutable versions)
  renders/          # preview and final output files
  logs/             # every ffmpeg command logged here
```

## Stack

- **Runtime:** Node 20+, TypeScript
- **MCP:** `@modelcontextprotocol/sdk` (stdio transport)
- **Schema/validation:** `zod`
- **Database:** `better-sqlite3` (SQLite, synchronous)
- **Process execution:** `execa`
- **Claude API:** `@anthropic-ai/sdk` (vision analysis + cut proposal)
- **Video:** ffmpeg + ffprobe (`brew install ffmpeg`) — Apple Silicon hardware encoding via `h264_videotoolbox` / `hevc_videotoolbox`

## Hard Constraints

- **USB source is READ-ONLY.** Never write, move, rename, or delete files under the source path. All derived artifacts go to `~/SkyCut/projects/`.
- **Workspace deletions require explicit user confirmation.** Never auto-delete.
- **Final renders only via explicit `skycut_render_final` with a named version.** Never auto-finalize.
- **USB resilience:** every tool touching source files must check path existence and return a clear "drive not mounted — reconnect and retry" error.
- **Hardware encoding mandatory:** use `h264_videotoolbox` (preview) and `hevc_videotoolbox` (final) — no software encoding fallbacks in production paths.
- **Vision API cost guard:** if > 500 frames before `analyze_footage`, report the count and wait for user confirmation before calling the API.
- **Log every ffmpeg command** to `logs/` for debuggability.

## MCP Tool Surface (prefix: `skycut_`)

| Tool | Key behavior |
|------|-------------|
| `skycut_init_project(source_path, name?)` | Validates path, creates workspace, sets active project |
| `skycut_list_volumes()` | Lists `/Volumes/*` with free space |
| `skycut_scan_footage()` | ffprobe all clips, write manifest + SQLite, generate 720p proxies (idempotent) |
| `skycut_analyze_footage(force?)` | Sample keyframes, batch to Claude vision, build segments (idempotent) |
| `skycut_search_moments(query)` | SQL + free-text search over footage graph |
| `skycut_propose_cut(brief, duration_s, style?, music_path?)` | Single Claude API call → validated timeline v<N>.json |
| `skycut_get_timeline(version?)` | Return timeline JSON + summary |
| `skycut_apply_timeline_edit(edit)` | Structured diff → new immutable version |
| `skycut_render_preview(version?)` | 720p from proxies |
| `skycut_render_final(version)` | Full-res from USB source; explicit version required |
| `skycut_project_status()` | Pipeline state + drive mount check |

## Timeline Schema

Defined in `schemas/timeline.ts` (zod). Key validation rules:
- `out_s > in_s` for every clip
- Every `clip_id` must exist in the manifest
- Computed total duration within ±5% of any requested target
- All clip timecodes within source clip duration

## Build Phases (see `progress.md` for current status)

0. Scaffold + dep checks → `npm run build` clean, server boots
1. Project/workspace + `init_project`, `list_volumes`
2. Scan + proxies (test clips via ffmpeg `testsrc` if no footage)
3. Analysis pipeline (vision mocked in tests, live behind `ANTHROPIC_API_KEY`)
4. Timeline engine — unit tested
5. Render pipelines (preview from test clips)
6. Director (`propose_cut`) — synthetic fixture
7. Wire-up + README (full MCP Inspector happy path)
8. Evals (`eval/questions.xml`)

## Environment Requirements

```bash
node --version      # 20+
ffmpeg -version     # required
echo $ANTHROPIC_API_KEY  # required for vision analysis and cut proposal
```
