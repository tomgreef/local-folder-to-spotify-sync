# spotify-genre-sync

Mirror local, genre-organized music folders to Spotify playlists.

> **Important constraint:** Spotify's API can't host your local audio. This tool
> *matches* your files against Spotify's catalog and mirrors a playlist per genre.
> Tracks not in the catalog (bootlegs, your own edits) can't be synced — they go
> to a CSV report instead.

## How it works

```
~/Music/<Genre>/...  →  read ID3 tags  →  Spotify search  →  confidence score  →  mirror "Local: <Genre>" playlist
```

- Each **top-level folder** under `MUSIC_ROOT` is a genre.
- **Mirror** semantics: the playlist is made to exactly equal the matched set —
  new matches are added, tracks no longer present locally are removed.
- Matches below `MATCH_THRESHOLD` are skipped and written to `reports/`.

## Setup

1. Create a Spotify app at https://developer.spotify.com/dashboard and add the
   redirect URI exactly: `http://127.0.0.1:8888/callback`.
2. Copy config and fill it in:
   ```bash
   cp .env.example .env   # set SPOTIFY_CLIENT_ID and MUSIC_ROOT
   npm install
   ```

## Run

```bash
# Preview only — shows +added/-removed per playlist, writes the report, no changes:
npm run sync -- --dry-run

# Apply for real:
npm run sync

# Tune matching strictness (0..1) or request concurrency:
npm run sync -- --threshold=0.85 --concurrency=4

# Cap fresh Spotify lookups per run (chunk the initial match under the daily quota):
npm run sync -- --dry-run --limit=150
```

## Spotify's daily quota (important)

Development-mode apps have an **undocumented daily request cap** on top of the
published 30-second rolling-window limit. Cross it and Spotify returns a 429
with a 6–24h `Retry-After` — effectively locking the app out for the day.
Slowing requests down does **not** help, because the cap is on *total daily
calls*, not speed.

Matching ~900 tracks in one shot exceeds this. Strategy:

- Matching is a **one-time** cost — results are cached, so once a track is
  looked up it never hits the API again.
- Use `--limit=N` to do, say, 150 lookups per day until the cache is complete.
  Re-runs skip everything already cached.
- If any tracks are still un-looked-up, the sync phase is **skipped on purpose**
  so mirror mode can't delete tracks that merely haven't been matched yet.
- Don't re-run during an active cooldown — a fresh call can restart the timer.

Once matching is fully cached, ongoing syncs make almost no search calls (only
new tracks + a handful of playlist read/writes), so they stay well under the cap.

First run opens a browser for a one-time authorization. The refresh token is
cached at `~/.spotify-genre-sync/token.json` (mode 600); later runs are silent.

## Notes

- **Auth:** Authorization Code + PKCE, no client secret stored.
- **Rate limits:** requests retry on HTTP 429 using `Retry-After`.
- **Matching** is the tunable part: edit `score()` weights or `normalize()` in
  `src/match.ts`. Start with `--dry-run` and inspect the report before applying.
- **Safety:** mirror mode removes tracks. Always dry-run after big local changes.

## Layout

```
src/
  index.ts    CLI: scan → match → plan → apply → report
  config.ts   env loading + paths
  auth.ts     PKCE flow + token cache
  spotify.ts  API client (pagination + 429 handling)
  scan.ts     folder walk + tag reading
  match.ts    search + Dice-coefficient confidence scoring
  sync.ts     per-genre add/remove diff
  report.ts   CSV of skipped tracks
```
