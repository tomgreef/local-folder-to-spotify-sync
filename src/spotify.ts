import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import type { SpotifyTrack } from "./types.js";

const API = "https://api.spotify.com/v1";
const CACHE_FILE = resolve(config.cacheDir, "search-cache.json");

/** If Spotify asks us to wait longer than this (s), abort rather than sleep. */
const MAX_BACKOFF_S = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thrown when Spotify imposes a long cooldown; the run should stop, not sleep. */
export class RateLimitError extends Error {
  constructor(public readonly retryAfterSec: number) {
    super(`Spotify rate-limit cooldown of ~${retryAfterSec}s`);
    this.name = "RateLimitError";
  }
}

/** Thrown when the per-run fresh-search budget is used up (no API call made). */
export class BudgetExhaustedError extends Error {
  constructor() {
    super("Per-run search budget exhausted");
    this.name = "BudgetExhaustedError";
  }
}

export class SpotifyClient {
  private throttleNotified = false;
  private cache = new Map<string, SpotifyTrack[]>();
  private cacheDirty = false;
  private nextSlot = 0;
  private searchBudget = Number.POSITIVE_INFINITY;

  constructor(private readonly token: string) {
    try {
      const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Record<string, SpotifyTrack[]>;
      this.cache = new Map(Object.entries(raw));
    } catch {
      /* no cache yet */
    }
  }

  /** Persist the search cache to disk. Call periodically and at the end. */
  saveCache(): void {
    if (!this.cacheDirty) return;
    mkdirSync(config.cacheDir, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(this.cache)), "utf8");
    this.cacheDirty = false;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${API}${path}`;
    for (let attempt = 0; attempt < 6; attempt++) {
      // Space request starts apart across all concurrent workers.
      const now = Date.now();
      const wait = Math.max(0, this.nextSlot - now);
      this.nextSlot = Math.max(now, this.nextSlot) + config.requestIntervalMs;
      if (wait) await sleep(wait);

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      let resp: Response;
      try {
        resp = await fetch(url, {
          ...init,
          signal: ctrl.signal,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            ...(init.headers ?? {}),
          },
        });
      } catch (e) {
        clearTimeout(timer);
        if ((e as Error).name === "AbortError") {
          if (attempt < 5) {
            await sleep(1000);
            continue; // retry a stalled request instead of hanging forever
          }
          throw new Error(`Request timed out after retries: ${path}`);
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }

      if (resp.status === 429) {
        const retry = Number(resp.headers.get("Retry-After") ?? "2");
        if (retry > MAX_BACKOFF_S) {
          this.saveCache(); // persist progress before bailing
          throw new RateLimitError(retry);
        }
        if (!this.throttleNotified) {
          process.stderr.write(`\n  (rate-limited by Spotify; backing off ~${retry}s — this is normal)\n`);
          this.throttleNotified = true;
        }
        await sleep((retry + 1) * 1000);
        continue;
      }
      if (resp.status >= 500) {
        if (attempt < 5) { await sleep(2000 * (attempt + 1)); continue; }
        throw new Error(`Spotify ${resp.status} on ${path}: ${await resp.text()}`);
      }
      if (!resp.ok) {
        throw new Error(`Spotify ${resp.status} on ${path}: ${await resp.text()}`);
      }
      if (resp.status === 204) return undefined as T;
      return (await resp.json()) as T;
    }
    throw new Error(`Rate-limited repeatedly on ${path}`);
  }

  async me(): Promise<{ id: string }> {
    return this.req("/me");
  }

  /** Cap the number of *fresh* (uncached) searches this run will perform. */
  setSearchBudget(n: number): void {
    this.searchBudget = n;
  }

  /** Read from cache without consuming budget or making any API call. */
  peekCache(query: string): SpotifyTrack[] | undefined {
    return this.cache.get(query);
  }

  async searchTrack(query: string): Promise<SpotifyTrack[]> {
    const cached = this.cache.get(query);
    if (cached) return cached;
    if (this.searchBudget <= 0) throw new BudgetExhaustedError();
    this.searchBudget--; // reserve the slot before the await
    const q = encodeURIComponent(query);
    const data = await this.req<{
      tracks: { items: { uri: string; name: string; artists: { name: string }[] }[] };
    }>(`/search?type=track&limit=10&q=${q}`);
    const results = data.tracks.items.map((t) => ({
      uri: t.uri,
      name: t.name,
      artists: t.artists.map((a) => a.name),
    }));
    this.cache.set(query, results);
    this.cacheDirty = true;
    return results;
  }

  /** All playlists owned by the current user, paginated. */
  async listMyPlaylists(userId: string): Promise<{ id: string; name: string }[]> {
    type Page = {
      items: { id: string; name: string; owner: { id: string } }[];
      next: string | null;
    };
    const out: { id: string; name: string }[] = [];
    let next: string | null = "/me/playlists?limit=50";
    while (next) {
      const page: Page = await this.req<Page>(next);
      for (const p of page.items) {
        if (p.owner.id === userId) out.push({ id: p.id, name: p.name });
      }
      next = page.next;
    }
    return out;
  }

  async createPlaylist(_userId: string, name: string): Promise<string> {
    const data = await this.req<{ id: string }>(`/me/playlists`, {
      method: "POST",
      body: JSON.stringify({ name, public: false, description: "Synced from local music folders." }),
    });
    return data.id;
  }

  /** All track URIs currently in a playlist, in order, paginated. */
  async playlistTrackUris(playlistId: string): Promise<string[]> {
    type Page = { items: { item: { uri: string; type: string } | null }[]; next: string | null };
    const out: string[] = [];
    let next: string | null = `/playlists/${playlistId}/items?fields=items(item(uri,type)),next&limit=100`;
    while (next) {
      const page: Page = await this.req<Page>(next);
      for (const it of page.items) if (it.item?.uri && it.item.type === "track") out.push(it.item.uri);
      next = page.next;
    }
    return out;
  }

  async addTracks(playlistId: string, uris: string[]): Promise<void> {
    for (let i = 0; i < uris.length; i += 100) {
      await this.req(`/playlists/${playlistId}/items`, {
        method: "POST",
        body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
      });
    }
  }

  async removeTracks(playlistId: string, uris: string[]): Promise<void> {
    for (let i = 0; i < uris.length; i += 100) {
      await this.req(`/playlists/${playlistId}/items`, {
        method: "DELETE",
        body: JSON.stringify({ items: uris.slice(i, i + 100).map((uri) => ({ uri })) }),
      });
    }
  }
}
