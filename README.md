# SkyCut

Local-first MCP server (stdio, TypeScript) that turns a folder of raw drone footage into a polished marketing cut:

**scan → analyze (vision) → footage graph → propose cut → human approve → render**

Status: under construction — see `progress.md` for build state and `prompt_plan.md` for the full spec.

## Requirements

- Node 20+
- ffmpeg + ffprobe (`brew install ffmpeg`) — Apple Silicon videotoolbox encoders used for all renders
- `ANTHROPIC_API_KEY` for vision analysis and cut proposal

## Development

```bash
npm install
npm run build
npm run inspector   # MCP Inspector against dist/index.js
npm test
```
