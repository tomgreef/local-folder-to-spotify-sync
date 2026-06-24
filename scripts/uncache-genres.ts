/**
 * Remove search-cache entries for all tracks in the specified genres.
 * Usage: tsx scripts/uncache-genres.ts "House" "Tech House"
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parseFile } from "music-metadata";

const CACHE_FILE = resolve(process.cwd(), ".cache/search-cache.json");
const MUSIC_ROOT = (() => {
  try {
    const env = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of env.split("\n")) {
      const eq = line.indexOf("=");
      if (eq !== -1 && line.slice(0, eq).trim() === "MUSIC_ROOT") {
        const v = line.slice(eq + 1).trim();
        return v.startsWith("~") ? resolve(process.env.HOME!, v.slice(1)) : v;
      }
    }
  } catch {}
  throw new Error("MUSIC_ROOT not found in .env");
})();

const AUDIO_EXT = new Set([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".aiff", ".wma"]);

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (AUDIO_EXT.has(extname(e.name).toLowerCase())) yield full;
  }
}

function fromFilename(file: string): { artist?: string; title: string } {
  const stem = basename(file, extname(file));
  const dash = stem.indexOf(" - ");
  if (dash !== -1) return { artist: stem.slice(0, dash).trim(), title: stem.slice(dash + 3).trim() };
  return { title: stem.trim() };
}

function queryTitle(title: string): string {
  const cleaned = title
    .replace(/\s*\(feat\.?[^)]*\)/gi, "")
    .replace(/\bfeat\.?\s+\S[^([,]*/gi, "")
    .replace(/\s*\((extended|original|radio)\s*(mix|version|edit)?\s*\)/gi, "")
    .replace(/\s*-\s*(extended|original|radio)\s*(mix|version|edit)?\s*$/gi, "")
    .trim();
  return cleaned || title;
}

function queryArtist(artist: string): string {
  const first = artist.split(",")[0]!.trim();
  return first.replace(/\s*\([A-Za-z]{2,5}\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

const genres = process.argv.slice(2);
if (genres.length === 0) {
  console.error("Usage: tsx scripts/uncache-genres.ts <Genre1> [Genre2] ...");
  process.exit(1);
}

console.log(`Genres to uncache: ${genres.join(", ")}`);
console.log(`Music root: ${MUSIC_ROOT}`);

const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Record<string, unknown>;
const before = Object.keys(cache).length;

for (const genre of genres) {
  const dir = join(MUSIC_ROOT, genre);
  let count = 0;
  for await (const file of walk(dir)) {
    let artist: string | undefined;
    let title: string | undefined;
    try {
      const { common } = await parseFile(file, { duration: false, skipCovers: true });
      artist = common.artist ?? common.albumartist;
      title = common.title;
    } catch {}
    if (!title) {
      const g = fromFilename(file);
      title = g.title;
      artist ??= g.artist;
    }
    if (!title) continue;

    const qt = queryTitle(title);
    const qa = artist ? queryArtist(artist) || null : null;

    const keys = new Set<string>();
    // Old format (what was originally cached)
    if (artist) keys.add(`track:${title} artist:${artist}`);
    else keys.add(`track:${title}`);
    // New cleaned format
    if (qa) {
      keys.add(`track:${qt} artist:${qa}`);
      keys.add(`${qt} ${qa}`);
    } else {
      keys.add(`track:${qt}`);
    }
    keys.add(qt);

    for (const k of keys) {
      if (k in cache) {
        delete cache[k];
        count++;
      }
    }
  }
  console.log(`  ${genre}: removed ${count} cache entries`);
}

const after = Object.keys(cache).length;
writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf8");
console.log(`\nCache: ${before} → ${after} entries (removed ${before - after})`);
