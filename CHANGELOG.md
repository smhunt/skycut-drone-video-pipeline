# Changelog

All notable changes to SkyCut are documented here. Versioning follows [semver](https://semver.org/).

## [0.6.0] - 2026-09-18

### Added
- **Footage panel (📁)** — onboard footage without leaving the browser:
  - **Folder browser** — volumes with free space, breadcrumb navigation, per-folder video counts (read-only listing); "Use this folder" inits the project and scans
  - **Uploads** — drag-and-drop or file-picker upload of `.mp4/.mov/.mts/.mkv` into `~/SkyCut/uploads/<project>/` (streamed to a temp name, renamed atomically), then auto-init + scan
  - **Scan & analyze from the UI** — SSE progress bars; the >500-frame vision cost gate surfaces an estimated dollar figure with explicit Analyze/Cancel buttons
  - **Project list + switching** — all workspaces under `~/SkyCut/projects` with mounted/unplugged badges; switching uses the new `setActiveProject` core export so it works with the source drive unplugged, and archives the (global) chat so context doesn't leak between projects
- New endpoints: `GET /api/projects`, `POST /api/project/switch`, `POST /api/project/init`, `GET /api/project/scan` (SSE), `GET /api/project/analyze` (SSE), `GET /api/fs/volumes`, `GET /api/fs/browse`, `PUT /api/upload`; `/api/status` now reports slug, source path and mount state
- Long panel jobs (scan/analyze) are serialized behind the chat turn queue — no torn reads of `footage.db` while the agent is mid-turn

## [0.5.0] - 2026-09-18

### Added
- **Retrim by dragging shot edges** — each shot in the timeline panel now has grab handles on both edges. Dragging adjusts the in/out points live (pixel deltas map to source seconds through the shot's width and speed, clamped to `[0, source duration]` with a 0.2 s minimum), and releasing posts a structured `retrim` edit that saves a new immutable version. Server-side validation failures (e.g. a transition longer than the trimmed clip) surface in the chat log and the strip reverts
- **Keyframe thumbnails** — timeline shots display the vision-analysis keyframe nearest their in-point as a background image (served same-origin from `frames/<clip_id>/`), with a darkening gradient so labels stay legible. Shots fall back to the flat style when a clip hasn't been analyzed yet
- `/api/timeline` now includes per-clip keyframe info (count, interval, base URL) alongside `rel_path` and `duration_s`

## [0.4.0] - 2026-07-07

### Added
- **Timeline panel** (🎞️ button in the chat UI) — visual shot strip with widths proportional to on-screen duration, transition markers, and click-for-details (trim, speed, source clip, exit transition). Drag a shot to reorder: each drop applies a structured `reorder` edit server-side and saves a new immutable version, logged to the chat transcript
- **Version compare** — pick any two timeline versions and see both strips stacked with a computed diff (added / removed / retrimmed / re-sped / moved shots, transition and music changes, duration delta), color-coded on the strips
- **About modal** — in-app Changelog, How It Works guide, and Roadmap tabs with a version badge
- **Live header stats** — project name, clip/segment counts, and version count now come from `/api/status` instead of being hardcoded
- New HTTP endpoints: `GET /api/status`, `GET /api/timeline?version=N`, `POST /api/timeline/edit`

### Changed
- Chat-agent and HTTP timeline edits share one code path (`applyEditsAndSave`); the agent's system prompt notes that versions can also be created from the UI

## [0.3.0] - 2026-07-06

### Added
- **Royalty-free music** — Jamendo catalog search (commercial-use licenses), in-chat and 🎵-panel preview, download into a local library (`~/SkyCut/music`), and chat-agent tools (`search_music`, `download_music`, `list_music`) wired to `set_music` edits
- **Cost tracking** — per-turn and per-session USD + token counts shown in the chat UI
- **Plyr video players** — auto-hiding controls when idle, click-to-play, keyboard shortcuts; single-player rule (starting any audio/video pauses all others)

### Fixed
- Same-origin media serving (root cause of dead inline players) with HTTP range support for Safari
- Persistent, transactional chat history that survives server restarts; stacked players no longer compress when the log overflows

## [0.2.0] - 2026-07-05

### Added
- **Chat web UI** (`npm run web`, https://dev.ecoworks.ca:3080) — local MVP, no auth: conversational agent (Claude + tool use over the SkyCut core, in-process) for proposing cuts, iterating with structured edits, and rendering; SSE streaming of tool activity and live render progress; previews/finals embed as inline video players (served from the :5502 static file server over `~/SkyCut/projects`)
- **MCP progress notifications** on `scan_footage`, `analyze_footage`, and both render tools (`notifications/progress` with per-item messages)
- **Parallel pipelines**: 4 concurrent proxy encoders, 3 concurrent clips in vision analysis (~3× faster on both stages)
- Scanner follows symlinks — curated link-farm source folders work across drives

### Fixed
- Proxies encode to a temp name and rename atomically — interrupted scans can no longer leave truncated proxies that a re-scan would skip as complete

## [0.1.0] - 2026-07-05

Initial release — full MVP pipeline, built in 9 phases (see `progress.md` for per-phase history).

### Added
- **MCP server** (stdio, TypeScript, MCP SDK 1.29) with 12 `skycut_*` tools and startup dependency checks (Node 20+, ffmpeg/ffprobe, videotoolbox encoders, `ANTHROPIC_API_KEY`)
- **Project workspaces** under `~/SkyCut/projects/<slug>/` with persisted active-project pointer; source footage treated as strictly read-only
- **Footage scan**: recursive video discovery (`.mp4/.mov/.mts/.mkv`), ffprobe metadata including GPS tags, SQLite footage graph (better-sqlite3, WAL), `manifest.json`, idempotent 720p H.264 proxies (~5 Mbps, videotoolbox)
- **Vision analysis**: keyframe sampling (1 frame / 4 s, 768 px JPEG), Claude vision (`claude-sonnet-4-6`) in batches of 8, merged into scored segments (subjects, camera movement, quality flags, aesthetic 0–10); per-clip caching; cost-estimate confirmation gate for runs over 500 frames
- **Moment search**: SQL-backed filters (subject, movement, stability, exposure, min aesthetic) plus free text over notes
- **Timeline engine**: zod schema, semantic validation (out > in, timecodes within source, clip_ids in manifest, transitions shorter than adjacent clips, ±5 % duration target), immutable versions (`timelines/v<N>.json`), structured diff edits (insert / remove / reorder / retrim / set_transition / set_music)
- **AI director** (`propose_cut`): single Claude call over the top-150 segments with narrative-arc instructions; one automatic retry with validation errors fed back; never renders
- **Render pipelines**: two-stage assembly (per-clip normalize → xfade/concat filter-graph fold); 720p previews from proxies (drive-optional); final HEVC videotoolbox renders from USB originals capped at 4K; music bed with loudnorm −18 LUFS, gain, and fade-out; text overlays via drawtext with graceful degradation
- **Evals**: 10 read-only Q&A pairs (`eval/questions.xml`) executed as living tests against a synthetic footage fixture
- **Test suite**: 56 vitest tests (vision/director mocked; ffmpeg integration against generated `testsrc` clips)

### Fixed
- Runtime detection for ffmpeg builds lacking the `drawtext` filter (text overlays skip instead of failing the render)
