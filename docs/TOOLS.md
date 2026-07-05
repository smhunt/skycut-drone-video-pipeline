# SkyCut Tool Reference

Complete reference for all 12 MCP tools. Every tool returns human-readable text plus machine-readable `structuredContent`; expected failures (drive unplugged, missing project, invalid timeline) come back as clean `isError` results with actionable messages — the server never crashes on them.

**Typical order:** `list_volumes` → `init_project` → `scan_footage` → `analyze_footage` → (`search_moments`) → `propose_cut` → `get_timeline` / `render_preview` → `apply_timeline_edit` → `render_final`. `project_status` and `health` work at any time.

---

## skycut_health

Dependency status: Node version, ffmpeg, ffprobe, videotoolbox encoders, `ANTHROPIC_API_KEY`. Run first if other tools behave unexpectedly.

- **Input:** none
- **Output:** `ok` per dependency with actionable `detail` on failures
- **Read-only** ✓

## skycut_list_volumes

Lists `/Volumes/*` with free/total space in GB — for picking the source drive.

- **Input:** none
- **Output:** `{ volumes: [{ path, freeGb, totalGb }] }`
- **Read-only** ✓

## skycut_init_project

Creates (or reopens) a project workspace and makes it the **active project** (persisted — survives server restarts). The source path is treated as read-only forever after.

| Param | Type | Notes |
|---|---|---|
| `source_path` | string, required | Absolute path to the footage folder. If missing, the error lists mounted volumes. |
| `name` | string, optional | Project name; defaults to folder name. Slugified for the workspace dir. |

- **Output:** `{ name, slug, sourcePath, created, workspace }`
- Re-init with the same name keeps project identity but refreshes `sourcePath` (drive letters change).

```json
{ "source_path": "/Volumes/DJI/ogoki-lodge", "name": "Ogoki Lodge" }
```

## skycut_scan_footage

Recursively indexes video files (`.mp4 .mov .mts .mkv`, case-insensitive; hidden and `._*` AppleDouble files skipped) under the active project's source. For each file: ffprobe metadata → SQLite + `manifest.json`, then a 720p H.264 proxy (~5 Mbps, no audio, never upscaled).

- **Input:** none
- **Output:** `{ clipCount, totalDurationS, newClips, proxiesBuilt, proxiesSkipped, errors[] }`
- **Idempotent** ✓ — re-scan skips known clips and existing proxies. Per-file failures are collected in `errors`, not fatal.
- Requires the drive mounted.

## skycut_analyze_footage

Builds the footage graph: samples a keyframe every 4 s per clip (768 px JPEG, prefers proxies so the drive can be unplugged), sends batches of 8 to Claude vision, and merges consecutive frames with identical subjects+movement into scored segments.

| Param | Type | Notes |
|---|---|---|
| `force` | boolean, optional | Re-analyze clips even if cached |
| `confirm` | boolean, optional | Proceed with a large run after reviewing the estimate |

- **Output:** `{ clipsAnalyzed, clipsSkipped, framesAnalyzed, segmentCount, topSubjects[], errors[] }`
- **Cost gate:** if the run needs > 500 frames it returns `{ needsConfirmation: true, estimatedFrames, estimatedTokens }` *without* calling the API. Confirm with the user, then re-call with `confirm: true`.
- **Idempotent** ✓ — per-clip cache; requires `ANTHROPIC_API_KEY`.

Segment fields: `t_in`/`t_out` (seconds within the source clip), `subjects[]`, `movement` (orbit / push-in / pull-back / flyover / pan / static / reveal), `avg_aesthetic` (0–10), `exposure` (good/over/under), `horizon` (level/tilted), `stability` (smooth/jittery), `notes`.

## skycut_search_moments

SQL-backed query over the footage graph. All filters combine with AND.

| Param | Type | Notes |
|---|---|---|
| `subject` | string | exact tag match, e.g. `"lodge"` |
| `movement` | enum | one of the movement types above |
| `min_aesthetic` | number 0–10 | minimum score |
| `stability` | `"smooth"` \| `"jittery"` | |
| `exposure` | `"good"` \| `"over"` \| `"under"` | |
| `text` | string | free text against notes and subjects |
| `limit` | int ≤ 200 | default 25 |

- **Output:** `{ moments: [{ clip_id, rel_path, t_in, t_out, subjects[], movement, avg_aesthetic, … }] }` sorted by score
- **Read-only** ✓

```json
{ "subject": "lodge", "movement": "orbit", "min_aesthetic": 7 }
```

## skycut_propose_cut

The AI director: one Claude call over the top-150 segments (by aesthetic) builds a timeline with a narrative arc (establish → reveal → activity → beauty → closing), varied camera movement, 3–8 s shots, 0.75 s crossfades, within ±5 % of the target duration. The result is zod- and semantically-validated; on failure the errors are fed back for **one** retry. Saved as the next immutable timeline version. **Never renders anything.**

| Param | Type | Notes |
|---|---|---|
| `brief` | string, required | creative brief |
| `duration_s` | number ≤ 600, required | target duration, ±5 % enforced |
| `style` | string, optional | style hints |
| `music_path` | string, optional | absolute path; the server sets the music bed (gain −6 dB, 2 s fade-out) — model output can't inject it |

- **Output:** `{ timeline, attempts }` + shot-list text
- Requires `ANTHROPIC_API_KEY` and a non-empty footage graph.

```json
{ "brief": "Cinematic 90-second marketing cut for a fly-in fishing lodge. Slow aerial build, reveal the lodge at golden hour, end on a wide sunset pull-back.", "duration_s": 90 }
```

## skycut_get_timeline

Returns a timeline version (latest by default) as JSON plus a readable shot list with running timecodes.

| Param | Type | Notes |
|---|---|---|
| `version` | int, optional | omit for latest |

- **Output:** `{ timeline, versions[], duration_s }`
- **Read-only** ✓

## skycut_apply_timeline_edit

Applies structured edits (in order) or replaces the timeline wholesale. The result is validated, then saved as a **new** version — versions are never mutated.

| Param | Type | Notes |
|---|---|---|
| `edits` | array, optional | structured ops (below) |
| `timeline` | object, optional | full replacement (alternative to `edits`) |
| `base_version` | int, optional | version to edit; omit for latest |

**Edit operations:**

| Op | Shape |
|---|---|
| insert | `{ "op": "insert", "at_index": 0, "clip": { "id", "clip_id", "in_s", "out_s", "speed"?, "transition_out"?, "label"? } }` |
| remove | `{ "op": "remove", "id": "c3" }` |
| reorder | `{ "op": "reorder", "id": "c3", "to_index": 0 }` |
| retrim | `{ "op": "retrim", "id": "c3", "in_s"?, "out_s"?, "speed"? }` |
| set_transition | `{ "op": "set_transition", "id": "c3", "transition": { "type": "xfade", "style": "fade", "duration_s": 0.75 } }` — `null` for a hard cut |
| set_music | `{ "op": "set_music", "music": { "path", "gain_db", "fade_out_s" } }` — `null` to remove |

- **Output:** `{ timeline, changes[] }` — per-op human-readable summaries + new shot list

## skycut_render_preview

Fast 720p render from **proxies** — works with the source drive unplugged. H.264 videotoolbox 8 Mbps, music bed and overlays included.

| Param | Type | Notes |
|---|---|---|
| `version` | int, optional | omit for latest |

- **Output:** `{ path, durationS, sizeBytes, width, height, timelineVersion }`
- Output file: `renders/<slug>-v<N>-preview.mp4`

## skycut_render_final

Full-quality render from the **originals on the USB drive**: HEVC videotoolbox (`-q:v 60`, `hvc1` tag for QuickTime), capped at 4K, AAC 192k audio.

| Param | Type | Notes |
|---|---|---|
| `version` | int, **required** | explicit — there is deliberately no "latest" default |

- **Output:** `{ path, durationS, sizeBytes, width, height, timelineVersion }`
- Requires the drive mounted; errors clearly if not.

## skycut_project_status

Pipeline state at a glance: scan/analysis counts, timeline versions, renders on disk, drive-mount status, and the suggested next step.

- **Input:** none
- **Output:** `{ active, project, sourceMounted, clipCount, proxyCount, analyzedCount, segmentCount, timelineVersions[], renders[] }`
- **Read-only** ✓

---

## Timeline JSON Schema

Source of truth: `src/schemas/timeline.ts` (zod). Shape:

```jsonc
{
  "version": 3,                          // server-assigned, immutable
  "project": "ogoki-lodge",
  "created": "2026-07-05T21:00:00Z",
  "output": { "width": 3840, "height": 2160, "fps": 29.97 },
  "music": {                             // optional
    "path": "/Users/sean/SkyCut/music/bed.mp3",
    "gain_db": -6,
    "fade_out_s": 2
  },
  "clips": [
    {
      "id": "c1",                        // timeline-local handle for edits
      "clip_id": "a1b2c3d4e5f6",         // FK into the footage graph
      "in_s": 42.0, "out_s": 48.5,       // source timecodes
      "speed": 1.0,                       // 0.25–4.0
      "transition_out": {                 // into the NEXT clip; omit = hard cut
        "type": "xfade", "style": "fade", "duration_s": 0.75
      },
      "label": "golden-hour lodge reveal, push-in"
    }
  ],
  "text_overlays": [
    { "text": "Ogoki Reservoir Lodge", "t_in": 2.0, "t_out": 6.0,
      "position": "lower-third", "size": "large" }   // positions: lower-third | center | top
  ]
}
```

**Validation rules** (enforced on every propose/edit):
- `out_s > in_s` for every clip; timecodes within the source clip's duration
- every `clip_id` exists in the footage manifest; timeline-local `id`s unique
- transitions must be shorter than both adjacent clips
- computed total duration — `Σ (out−in)/speed − Σ transition overlaps` — within ±5 % of any requested target

## Error Conventions

| Error text contains | Meaning |
|---|---|
| `drive not mounted — reconnect and retry` | Source path unreachable; proxy-based operations still work |
| `No active project` | Call `skycut_init_project` first |
| `ANTHROPIC_API_KEY is not set` | Needed only by `analyze_footage` / `propose_cut` |
| `Timeline validation failed:` | Bulleted list of every semantic problem found |
| `failed validation after 2 attempts` | Director couldn't produce a valid cut — adjust brief/duration or re-analyze |
