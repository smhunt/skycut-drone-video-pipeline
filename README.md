# SkyCut

Local-first MCP server (stdio, TypeScript) that turns a folder of raw drone footage into a polished marketing cut, driven conversationally from Claude Code or Claude Desktop:

**scan → analyze (vision) → footage graph → propose cut → human approve → render**

Point it at a USB drive of raw drone video and produce a 60–90 second marketing edit with crossfades and an optional music bed. The source drive is treated as **read-only**; all derived artifacts (proxies, frames, timelines, renders) live in `~/SkyCut/projects/<slug>/` on the internal disk.

## Requirements

- **Node 20+**
- **ffmpeg + ffprobe** — `brew install ffmpeg` (Apple Silicon videotoolbox hardware encoders used for all renders)
- **`ANTHROPIC_API_KEY`** — for vision analysis and cut proposal

## Install

```bash
npm install
npm run build
```

### Claude Code

```bash
claude mcp add skycut --env ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY -- node /absolute/path/to/skycut/dist/index.js
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "skycut": {
      "command": "node",
      "args": ["/absolute/path/to/skycut/dist/index.js"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

### Verify with MCP Inspector

```bash
npm run inspector
```

## Workflow

A typical session, in plain conversation with Claude:

1. `skycut_list_volumes()` — find the USB drive
2. `skycut_init_project("/Volumes/DJI/lodge-trip")` — create the workspace
3. `skycut_scan_footage()` — index clips, build 720p proxies (idempotent; unplug the drive afterwards if you like)
4. `skycut_analyze_footage()` — Claude vision scores every 4s keyframe into a searchable footage graph (cached; asks before runs over 500 frames)
5. `skycut_propose_cut("Cinematic 90-second marketing cut, slow build, reveal the lodge at golden hour", 90)` — AI director assembles timeline v1
6. `skycut_render_preview()` — fast 720p render from proxies; watch it
7. `skycut_apply_timeline_edit({ edits: [...] })` — revise; every edit is a new immutable version
8. `skycut_render_final(2)` — full-quality HEVC render from the originals (drive must be mounted)

Explore in between with `skycut_search_moments({ subject: "lodge", min_aesthetic: 7 })` and `skycut_project_status()`.

## Web UI

A local chat UI (no auth — local use only) wraps the same core pipeline in a browser:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run web   # → https://dev.ecoworks.ca:3080
```

- **Chat agent** — a Claude-driven agent with tool use over the SkyCut core (in-process, no MCP hop): propose cuts, search moments, apply edits, and render, with SSE-streamed progress bars and per-turn/session cost tracking
- **Timeline panel** (🎞️) — visual shot strip with keyframe thumbnails; drag shots to reorder, drag shot edges to retrim (every drop saves a new immutable version); click a shot for trim/speed/source details; compare any two versions with a color-coded diff
- **Music** (🎵) — search royalty-free tracks (Jamendo), preview in-chat, download into `~/SkyCut/music`
- **Renders** — previews and finals embed as inline players (same-origin media with HTTP range support)
- **About** — in-app changelog, how-it-works guide, and roadmap

The web server operates on the **active project** (the one last opened with `skycut_init_project`). Chat history persists across restarts; edits made in the panel and in chat share one code path and one version history.

## Tools

| Tool | Purpose |
|---|---|
| `skycut_health()` | Dependency status (ffmpeg, encoders, API key) |
| `skycut_list_volumes()` | Mounted volumes with free space |
| `skycut_init_project(source_path, name?)` | Create/reopen a project; source is read-only |
| `skycut_scan_footage()` | ffprobe metadata + manifest + SQLite + 720p proxies |
| `skycut_analyze_footage(force?, confirm?)` | Vision analysis → scored segments (footage graph) |
| `skycut_search_moments(filters)` | Query segments by subject/movement/quality/score/text |
| `skycut_propose_cut(brief, duration_s, style?, music_path?)` | AI director → validated timeline version |
| `skycut_get_timeline(version?)` | Timeline JSON + shot list |
| `skycut_apply_timeline_edit(edits \| timeline)` | Structured diff → new immutable version |
| `skycut_render_preview(version?)` | 720p from proxies |
| `skycut_render_final(version)` | Up-to-4K HEVC from originals; explicit version required |
| `skycut_project_status()` | Pipeline state + drive mount check |

## Guardrails

- The USB source is never written to; unplugging it mid-session degrades gracefully (proxies keep previews working)
- Timeline versions are immutable — edits always create `v<N+1>`
- Nothing is ever auto-finalized: `skycut_render_final` requires an explicit version
- Every ffmpeg command is logged to the project's `logs/ffmpeg.log`
- Vision runs needing more than 500 frames report an estimated cost and wait for confirmation

## Development

```bash
npm run build     # tsc (the web server imports from dist/ — rebuild before `npm run web`)
npm test          # vitest — vision/director mocked; ffmpeg integration uses generated testsrc clips
npm run inspector # poke the MCP server interactively
npm run web       # chat UI on https://dev.ecoworks.ca:3080 (needs ANTHROPIC_API_KEY)
```

## Documentation

- **[docs/README.md](docs/README.md)** — architecture, design decisions, workspace layout, troubleshooting, extending
- **[docs/TOOLS.md](docs/TOOLS.md)** — complete tool API reference, timeline schema, edit operations, error conventions
- **[CHANGELOG.md](CHANGELOG.md)** — version history
- `prompt_plan.md` (original spec) and `progress.md` (per-phase build history)
