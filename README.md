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
npm run build     # tsc
npm test          # vitest — vision/director mocked; ffmpeg integration uses generated testsrc clips
npm run inspector # poke the server interactively
```

Architecture and build-phase history: see `prompt_plan.md` (spec) and `progress.md` (what shipped when).
