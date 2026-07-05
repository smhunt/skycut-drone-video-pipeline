# Changelog

All notable changes to SkyCut are documented here. Versioning follows [semver](https://semver.org/).

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
