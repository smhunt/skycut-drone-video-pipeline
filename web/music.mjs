// Royalty-free music: search (Jamendo catalog — direct API with JAMENDO_CLIENT_ID,
// keyless via Openverse otherwise), download to the local library, list.
// Licenses are filtered to commercial + modification friendly (CC0 / CC-BY / CC-BY-SA)
// because cuts are marketing videos; attribution strings are stored with every track.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const MUSIC_DIR = path.join(os.homedir(), "SkyCut", "music");
const LIBRARY_FILE = path.join(MUSIC_DIR, "library.json");

function readLibrary() {
  try {
    return JSON.parse(fs.readFileSync(LIBRARY_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeLibrary(tracks) {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(tracks, null, 2));
}

export function listMusic() {
  return readLibrary();
}

/** Most recent search results by id — lets the agent/UI download by short id. */
const searchCache = new Map();

export async function searchMusic(query, { maxDurationS, limit = 12 } = {}) {
  const tracks = process.env.JAMENDO_CLIENT_ID
    ? await searchJamendo(query, limit)
    : await searchOpenverse(query, limit);
  const filtered = maxDurationS ? tracks.filter((t) => t.duration_s <= maxDurationS) : tracks;
  const library = new Set(readLibrary().map((t) => t.id));
  for (const t of filtered) {
    t.in_library = library.has(t.id);
    searchCache.set(t.id, t);
  }
  return filtered;
}

async function searchOpenverse(query, limit) {
  // No source restriction: Jamendo's Openverse slice is mostly NC-licensed, while the
  // commercial+modification filter (the part that matters legally) is well covered by
  // Freesound CC0/CC-BY. Direct Jamendo (JAMENDO_CLIENT_ID) uses its own CC filter.
  const params = new URLSearchParams({
    q: query,
    license_type: "commercial,modification",
    page_size: String(Math.min(limit, 20)),
  });
  const res = await fetch(`https://api.openverse.org/v1/audio/?${params}`, {
    headers: { "User-Agent": "SkyCut/0.3 (local drone-video tool)" },
  });
  if (!res.ok) throw new Error(`Openverse search failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.results ?? []).map((r) => ({
    id: `ov-${r.id.slice(0, 8)}`,
    title: r.title,
    artist: r.creator ?? "unknown",
    duration_s: Math.round((r.duration ?? 0) / 1000),
    license: `${r.license}${r.license_version ? ` ${r.license_version}` : ""}`,
    attribution: r.attribution ?? `"${r.title}" by ${r.creator} (CC ${r.license})`,
    source_page: r.foreign_landing_url ?? r.url,
    download_url: r.url,
    preview_url: r.url,
    provider: r.provider,
  }));
}

async function searchJamendo(query, limit) {
  const params = new URLSearchParams({
    client_id: process.env.JAMENDO_CLIENT_ID,
    format: "json",
    limit: String(limit),
    search: query,
    license_cc: "ccby,cc0,ccbysa", // commercial + modification friendly
    audioformat: "mp32",
    include: "licenses",
  });
  const res = await fetch(`https://api.jamendo.com/v3.0/tracks/?${params}`);
  if (!res.ok) throw new Error(`Jamendo search failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.results ?? []).map((r) => ({
    id: `jam-${r.id}`,
    title: r.name,
    artist: r.artist_name,
    duration_s: r.duration,
    license: r.license_ccurl?.includes("zero") ? "cc0" : r.license_ccurl?.split("/licenses/")[1]?.replace(/\/.*/, "") ?? "cc",
    attribution: `"${r.name}" by ${r.artist_name} — jamendo.com (${r.license_ccurl ?? "CC"})`,
    source_page: r.shareurl,
    download_url: r.audiodownload || r.audio,
    preview_url: r.audio,
    provider: "jamendo",
  }));
}

/** Download a track (by search-result id) into ~/SkyCut/music and catalog it. */
export async function downloadMusic(trackId) {
  const library = readLibrary();
  const existing = library.find((t) => t.id === trackId);
  if (existing) return { ...existing, already: true };

  const track = searchCache.get(trackId);
  if (!track) {
    throw new Error(`Unknown track id '${trackId}' — run search_music first (ids expire with the session).`);
  }

  const res = await fetch(track.download_url, {
    headers: { "User-Agent": "SkyCut/0.3 (local drone-video tool)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} from ${track.download_url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 10_000) throw new Error(`Download suspiciously small (${buffer.length} bytes) — source may be unavailable.`);

  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  const safeName = `${track.id}-${track.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.mp3`;
  const filePath = path.join(MUSIC_DIR, safeName);
  fs.writeFileSync(filePath, buffer);

  const entry = {
    ...track,
    file: safeName,
    path: filePath,
    size_mb: Math.round(buffer.length / 1e5) / 10,
    downloaded: new Date().toISOString(),
  };
  delete entry.in_library;
  library.push(entry);
  writeLibrary(library);
  return entry;
}
