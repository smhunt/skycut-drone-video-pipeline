# SkyCut Progress

## Phase 0 — Scaffold + dep checks ✅ (2026-07-05)

**Shipped:**
- npm project: TypeScript ESM (Node16 modules), MCP SDK 1.29, zod 3, better-sqlite3, execa, Anthropic SDK, vitest
- `src/core/deps.ts` — startup checks for Node 20+, ffmpeg, ffprobe, videotoolbox encoders, `ANTHROPIC_API_KEY`, with actionable messages
- `src/index.ts` — stdio MCP server entry; logs to stderr only; boots even with missing deps (tools error individually)
- `skycut_health` tool — re-runs dependency checks on demand

**Deviations:** none. Added `skycut_health` (not in spec's tool table) so Phase 0 has a listable, testable tool.

**Environment notes:** local ffmpeg had a broken x265 dylib; fixed via `brew reinstall x265`. `ANTHROPIC_API_KEY` not set in dev shell — vision/director phases test with mocks; live use requires the key in the MCP config env.

**Next:** Phase 1 — workspace management, `skycut_init_project`, `skycut_list_volumes`.

## Phase 1 — Workspace + init_project, list_volumes ✅ (2026-07-05)

**Shipped:**
- `core/project.ts` — workspace creation under `$SKYCUT_HOME` (default `~/SkyCut`), `project.json` meta, persisted active-project pointer, `assertSourceMounted` guard, `listVolumes` via `statfs`
- `core/errors.ts` (`UserError`, drive-not-mounted error) + `tools/util.ts` (`toolHandler` wrapper: UserErrors → clean isError results)
- Tools: `skycut_init_project` (validates path, lists /Volumes in error on miss, re-init preserves identity), `skycut_list_volumes` (free/total GB)
- 6 unit tests (vitest) passing

**Deviations:** added `SKYCUT_HOME` env override (testability) and a persisted active-project pointer so restarts keep context.

**Next:** Phase 2 — scan + proxies.

## Phase 2 — Scan + proxies ✅ (2026-07-05)

**Shipped:**
- `core/ffmpeg.ts` — execa wrappers; every ffmpeg/ffprobe call appended to `logs/ffmpeg.log`; `probeClip` (duration/res/fps/codec/bitrate/creation time/GPS tags); videotoolbox detection with libx264 fallback (logged)
- `core/graph.ts` — better-sqlite3 (WAL): `clips` + `segments` tables, upserts, indexes
- `core/scan.ts` — recursive video discovery (.mp4/.mov/.mts/.mkv, skips hidden/`._*`), stable `clip_id` = sha1(relpath:size)[:12], `manifest.json`, idempotent 720p ~5 Mbps proxies (no upscale: `scale=-2:min(720,ih)`, audio dropped)
- `skycut_scan_footage` tool; `src/test/fixtures.ts` generates testsrc clips
- 11 tests passing incl. scan integration with real ffmpeg

**Deviations:** proxies drop audio (drone audio is rotor noise, dropped at render anyway); libx264 fallback when videotoolbox is absent so tests stay portable.

**Next:** Phase 3 — analysis pipeline.

## Phase 3 — Analysis pipeline ✅ (2026-07-05)

**Shipped:**
- `core/frames.ts` — idempotent keyframe sampling (fps=1/4, 768px JPEG q3); prefers proxy over USB original for drive resilience
- `core/vision.ts` — Claude vision client (`claude-sonnet-4-6`, batches of 8 with timestamps, JSON-only system prompt); injectable `VisionClient` interface for tests; robust parsing (fence stripping, per-frame zod salvage, unknown movement → static, our timestamps win)
- `core/analyze.ts` — segment merging (consecutive frames w/ same subjects+movement → scored segments, quality by mode), analysis caching per clip, >500-frame runs return a token cost estimate requiring `confirm: true`, `searchMoments` with SQL filters + free text
- Tools: `skycut_analyze_footage(force?, confirm?)`, `skycut_search_moments`
- 20 tests passing (vision fully mocked; live path gated on `ANTHROPIC_API_KEY`)

**Deviations:** `skycut_search_moments` implemented here (spec's tool table lists it; phase table didn't assign it a phase).

**Next:** Phase 4 — timeline engine.

## Phase 4 — Timeline engine ✅ (2026-07-05)

**Shipped:**
- `schemas/timeline.ts` — zod source of truth (§6): output format, optional music bed, clips w/ speed 0.25–4 + xfade transitions, text overlays
- `core/timeline.ts` — semantic validation (out_s>in_s, clip_id in manifest, timecodes within source, transitions shorter than adjacent clips, ±5% duration target), duration math with transition overlaps, immutable versioning (`v<N>.json`, `wx` write flag), structured edits (insert/remove/reorder/retrim/set_transition/set_music) with human-readable summaries, shot-list renderer
- Tools: `skycut_get_timeline`, `skycut_apply_timeline_edit` (structured ops applied in order OR full replacement; result validated then saved as new version)
- 37 tests passing (17 new)

**Deviations:** `retrim` also accepts `speed`; edits accepted as an array applied in order.

**Next:** Phase 5 — render pipelines.

## Phase 5 — Render pipelines ✅ (2026-07-05)

**Shipped:**
- `core/render.ts` — two-stage assembly: per-clip trim/speed/normalize intermediates (uniform res/fps/yuv420p, letterbox pad), then a single filter_complex fold joining clips with `xfade` (per-clip style/duration) or `concat` (hard cuts), offsets from ffprobed intermediate durations
- Music bed: infinite loop + `atrim` to cut length, `loudnorm I=-18`, per-timeline gain, configurable fade-out, AAC 192k
- Text overlays via `drawtext` (centered, size/position mapped from schema) — skipped gracefully when the ffmpeg build lacks drawtext or the macOS font is missing
- Preview: 720p h264_videotoolbox 8 Mbps from proxies (drive-optional); Final: hevc_videotoolbox `-q:v 60` `hvc1` tag from USB originals, capped at 4K, drive-mount asserted
- Tools: `skycut_render_preview(version?)`, `skycut_render_final(version)` (version explicit, required)
- 40 tests passing (3 render integration tests: xfade+concat+music preview, final from originals, 4K cap)

**Deviations:** discovered local ffmpeg 8.1.2 build lacks `drawtext`; added runtime filter detection so overlays degrade instead of failing the render.

**Next:** Phase 6 — director (`propose_cut`).

## Phase 6 — Director ✅ (2026-07-05)

**Shipped:**
- `core/director.ts` — compact footage graph (top 150 segments by aesthetic + clip durations + dominant-resolution output capped at 4K), single Claude call (`claude-sonnet-4-6`), narrative-arc system prompt, JSON extraction, zod+semantic validation with ONE retry (validation errors fed back), server owns `version` and `music` (music_path param overrides anything the model emits), immutable save
- `skycut_propose_cut(brief, duration_s, style?, music_path?)` — returns shot list; never renders
- `src/test/synthetic.ts` — 5-clip / 12-segment fly-in lodge fixture (no media files; reused for Phase 8 evals)
- 45 tests passing (retry path, failure-after-2, music injection covered)

**Next:** Phase 7 — wire-up + README.

## Phase 7 — Wire-up + README ✅ (2026-07-05)

**Shipped:**
- `skycut_project_status` — scan/analysis/timeline/render state, drive-mount check, suggested next step
- Full README: install, Claude Code (`claude mcp add`) + Claude Desktop stdio config, workflow walkthrough, tool table, guardrails
- E2E happy path verified over real stdio (MCP SDK client → dist/index.js): 12 tools listed; init → scan (3 testsrc clips) → full-replacement timeline → structured edits (v2) → preview render → final render → status. All green.

**Next:** Phase 8 — evals.
