import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parseFile } from "music-metadata";
import { config } from "./config.js";
import type { LocalTrack } from "./types.js";

const AUDIO_EXT = new Set([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".aiff", ".wma"]);

/** Best-effort artist/title from "Artist - Title.ext" when tags are missing. */
function fromFilename(file: string): { artist?: string; title: string } {
  const stem = basename(file, extname(file));
  const dash = stem.indexOf(" - ");
  if (dash !== -1) {
    return { artist: stem.slice(0, dash).trim(), title: stem.slice(dash + 3).trim() };
  }
  return { title: stem.trim() };
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (AUDIO_EXT.has(extname(entry.name).toLowerCase())) yield full;
  }
}

/**
 * Scan the music root. Each top-level subfolder is a genre; audio files at any
 * depth beneath it inherit that genre. Files directly in the root are skipped.
 */
export async function scanLibrary(root: string): Promise<LocalTrack[]> {
  const tracks: LocalTrack[] = [];
  let genres;
  try {
    genres = await readdir(root, { withFileTypes: true });
  } catch {
    throw new Error(`Cannot read MUSIC_ROOT: ${root}`);
  }

  for (const genreDir of genres) {
    if (!genreDir.isDirectory() || genreDir.name.startsWith(".")) continue;
    if (config.ignoreGenres.includes(genreDir.name.toLowerCase())) continue;
    const genre = genreDir.name;
    for await (const file of walk(join(root, genreDir.name))) {
      let artist: string | undefined;
      let title: string | undefined;
      let album: string | undefined;
      try {
        const { common } = await parseFile(file, { duration: false, skipCovers: true });
        artist = common.artist ?? common.albumartist;
        title = common.title;
        album = common.album;
      } catch {
        /* fall through to filename parsing */
      }
      if (!title || !artist) {
        const guess = fromFilename(file);
        title ??= guess.title;
        artist ??= guess.artist;
      }
      if (!title) continue; // nothing usable
      tracks.push({ genre, artist: artist ?? "", title, album, path: file });
    }
  }
  return tracks;
}
