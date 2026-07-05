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
