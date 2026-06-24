import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function loadDotEnv(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // No .env file is fine; rely on real env vars.
  }
}

function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(1).replace(/^[/\\]/, "")) : resolve(p);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (copy .env.example to .env)`);
  return v;
}

loadDotEnv();

export const config = {
  clientId: required("SPOTIFY_CLIENT_ID"),
  musicRoot: expandHome(required("MUSIC_ROOT")),
  playlistTemplate: process.env.PLAYLIST_TEMPLATE ?? "Local: {genre}",
  matchThreshold: Number(process.env.MATCH_THRESHOLD ?? "0.8"),
  callbackPort: Number(process.env.CALLBACK_PORT ?? "8888"),
  /** Top-level folder names to skip (case-insensitive). */
  ignoreGenres: (process.env.IGNORE_GENRES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  /** Minimum ms between request starts. ~334ms ≈ 3 req/s ≈ 90 calls per 30s window. */
  requestIntervalMs: Number(process.env.REQUEST_INTERVAL_MS ?? "334"),
  get redirectUri() {
    return `http://127.0.0.1:${this.callbackPort}/callback`;
  },
  cacheDir: resolve(process.cwd(), ".cache"),
  scopes: ["playlist-modify-private", "playlist-modify-public", "playlist-read-private"],
} as const;

export function playlistNameFor(genre: string): string {
  return config.playlistTemplate.replace("{genre}", genre);
}
