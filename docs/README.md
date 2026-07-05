# SkyCut — Architecture & Developer Documentation

SkyCut is a local-first MCP server that turns a folder of raw drone footage into a polished marketing cut through an agent-driven workflow. This document covers the system design; see [TOOLS.md](TOOLS.md) for the complete tool API reference.

## System Overview

```
                        Claude Code / Claude Desktop
                                   │  (MCP, stdio JSON-RPC)
                                   ▼
┌──────────────────────────── SkyCut MCP Server ────────────────────────────┐
│                                                                           │
│  tools/  (12 skycut_* tools — thin wrappers, zod input schemas)           │
│     │                                                                     │
│  core/                                                                    │
│  ┌─────────┐  ┌────────┐  ┌────────┐  ┌──────────┐  ┌────────┐  ┌───────┐ │
│  │ project │  │  scan  │  │ frames │  │ analyze  │  │timeline│  │render │ │
│  │workspace│─▶│ffprobe │─▶│sampling│─▶│ vision + │─▶│validate│─▶│xfade  │ │
│  │manifest │  │proxies │  │        │  │ segments │  │version │  │assembly│ │
│  └─────────┘  └────────┘  └────────┘  └────┬─────┘  └───▲────┘  └───────┘ │
│                                            │            │                 │
│                                       ┌────▼────────────┴───┐             │
│                                       │ director (propose)  │             │
│                                       └─────────────────────┘             │
│        graph.ts — SQLite (clips, segments) │ ffmpeg.ts — execa + logging  │
└───────────────────────────────────────────────────────────────────────────┘
          │                                        │
          ▼                                        ▼
   USB source drive                       Anthropic API
   (READ-ONLY, resilient                  (claude-sonnet-4-6:
    to disconnect)                         vision + director)
```

**Pipeline:** scan → analyze (vision) → footage graph → propose cut → human approve → render.

The human stays in the loop at two points by design: reviewing the proposed timeline (and iterating with preview renders + edits), and explicitly triggering the final render.

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node 20+, TypeScript (ESM, Node16 modules) | strict mode |
| Protocol | `@modelcontextprotocol/sdk` 1.29 | stdio transport; `registerTool` with zod raw shapes + `structuredContent` |
| Validation | `zod` 3 | timeline schema is the source of truth (`src/schemas/timeline.ts`) |
| Database | `better-sqlite3` (WAL) | synchronous; one `footage.db` per project |
| Processes | `execa` | every ffmpeg/ffprobe call logged to `logs/ffmpeg.log` |
| AI | `@anthropic-ai/sdk`, `claude-sonnet-4-6` | vision frame analysis + director cut proposal |
| Video | ffmpeg / ffprobe | `h264_videotoolbox` (preview), `hevc_videotoolbox` (final); libx264 fallback where videotoolbox is unavailable |
| Tests | vitest | 56 tests; AI clients injected via interfaces and mocked |

## Source Layout

```
src/
  index.ts              server entry: dep checks, tool registration, stdio connect
  tools/                one file per tool group; toolHandler() wrapper maps
    util.ts             UserError → clean isError results
  core/
    deps.ts             startup dependency checks with actionable messages
    errors.ts           UserError (expected/actionable) vs unexpected errors
    project.ts          workspace dirs, project.json, active-project pointer, volume listing
    ffmpeg.ts           run wrappers + command logging, probeClip, capability detection
    graph.ts            SQLite schema + queries (clips, segments)
    scan.ts             discovery, clip_id hashing, manifest, proxy generation
    frames.ts           keyframe sampling (fps=1/4, 768px JPEG)
    vision.ts           Claude vision batching, response parsing/salvage, VisionClient interface
    analyze.ts          orchestration, segment merging, cost gate, searchMoments
    timeline.ts         validation, duration math, immutable versioning, edit ops
    render.ts           intermediate normalization, xfade/concat fold, music, overlays
    director.ts         footage-graph context, propose prompt, validate + retry
  schemas/timeline.ts   zod timeline schema (source of truth)
  test/                 fixtures: testsrc clip generator, synthetic footage graph
eval/questions.xml      10 executable Q&A evals
```

## Key Design Decisions

### The footage graph is the director's world model
Vision analysis converts each clip into *segments* — contiguous runs of frames sharing subjects + camera movement, scored 0–10 for aesthetics with quality flags (exposure/horizon/stability). The director never sees pixels; it plans the cut from the top ~150 segments as compact JSON. This keeps `propose_cut` to a single cheap API call.

### Two representations of identity
- `clip_id` = `sha1(rel_path:size_bytes)[:12]` — stable across drive remounts and path changes; primary key everywhere.
- Timeline-local `id` (`c1`, `c2`, …) — human-friendly handles for edit operations.

### Immutable timeline versions
`timelines/v<N>.json` files are written with the `wx` flag (fail-if-exists). Every edit — structured diff or full replacement — validates first, then saves `v<N+1>`. Nothing mutates history; `render_final` demands an explicit version number.

### Drive resilience
The USB source can disappear at any time:
- Proxies and sampled frames live on the internal SSD, so analysis, timeline work, and *preview* renders keep working unplugged.
- Every tool touching originals calls `assertSourceMounted` and returns a "reconnect and retry" error instead of crashing.
- `abs_path` is refreshed on every scan; identity survives via `clip_id`.

### AI clients are injected interfaces
`VisionClient` and `DirectorClient` are tiny interfaces. Production wires Anthropic implementations; tests inject mocks. Model responses are treated as untrusted input: fences stripped, JSON extracted, zod-validated per item with salvage, enum values coerced (`.catch()`), and our own frame timestamps override the model's echo. The director gets exactly one retry with the validation errors appended.

### Render assembly
Stage 1 normalizes each timeline clip into an intermediate (trim → speed via `setpts` → scale + letterbox pad → fps → yuv420p). Stage 2 folds intermediates pairwise in one `filter_complex`: `xfade` where a transition is set (offset computed from ffprobed intermediate durations), `concat` for hard cuts, then optional drawtext overlays and a music chain (`-stream_loop -1` → `atrim` → `loudnorm I=-18` → gain → `afade` out).

## Workspace Layout (per project)

```
~/SkyCut/projects/<slug>/     # override root with $SKYCUT_HOME
  project.json      # name, slug, sourcePath, created
  manifest.json     # clip registry (regenerated on each scan)
  footage.db        # SQLite: clips, segments
  proxies/          # <clip_id>.mp4 — 720p H.264 ~5 Mbps, no audio
  frames/<clip_id>/ # 0001.jpg … keyframes for vision analysis
  timelines/        # v1.json, v2.json … (immutable)
  renders/          # <slug>-v<N>-preview.mp4 / -final.mp4
  logs/ffmpeg.log   # every ffmpeg/ffprobe invocation with exit codes
```

## Guardrails (non-negotiable)

1. **USB source is read-only** — no writes, moves, renames, or deletes under the source path, ever.
2. **No auto-finalize** — `skycut_render_final` requires an explicit version argument.
3. **Workspace deletions require explicit user confirmation** — nothing is cleaned up automatically.
4. **Cost gate** — vision runs needing >500 frames report an estimate and require `confirm: true`.
5. **Full ffmpeg auditability** — every command is logged.

## Testing

```bash
npm test                 # full suite (~10s)
npx vitest run src/core/timeline.test.ts   # single file
npx vitest run -t "xfade"                  # single test by name
```

- Vision and director are **mocked** via their client interfaces; no API key needed.
- ffmpeg integration tests generate tiny `testsrc` clips on the fly (`src/test/fixtures.ts`).
- `src/test/synthetic.ts` builds a 5-clip / 12-segment "fly-in lodge" footage graph with no media files — used by director tests and the evals.
- `SKYCUT_HOME` redirects the workspace root to a temp dir in every test.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `drive not mounted — reconnect and retry` | Source path unreachable. Previews/analysis still work from proxies; reconnect for `render_final`. |
| `ANTHROPIC_API_KEY is not set` | Add it to the `env` block of the MCP server config (see root README). Only `analyze_footage` and `propose_cut` need it. |
| ffmpeg `dyld: Library not loaded (libx265)` | Broken homebrew ffmpeg after an upgrade — `brew reinstall x265` (or `brew reinstall ffmpeg`). |
| Text overlays missing from renders | Your ffmpeg build lacks the `drawtext` filter (no libfreetype). SkyCut detects this and skips overlays rather than failing. Install a full ffmpeg build to enable them. |
| Renders are slow / CPU-bound | Videotoolbox encoders not found — check `skycut_health`. Software fallback (libx264) is used automatically but is much slower. |
| `Timeline validation failed: total duration … outside ±5%` | The director/edit result drifted from the target. Retrim shots or relax the target duration. |

## Extending

- **New tool**: add `src/tools/<name>-tools.ts` exporting a `register…` function, wire it in `src/tools/index.ts`. Use `toolHandler` + `ok` from `tools/util.ts` and throw `UserError` for expected failures.
- **New timeline edit op**: extend `EditSchema` + the `applyEdit` switch in `core/timeline.ts` (add a test in `timeline.test.ts`).
- **New xfade style**: pass any ffmpeg xfade `transition` name via `transition_out.style` — it flows straight into the filter graph.
- **Different vision/director model**: change `VISION_MODEL` / `DIRECTOR_MODEL` constants in `core/vision.ts` / `core/director.ts`.
