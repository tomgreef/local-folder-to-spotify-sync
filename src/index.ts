#!/usr/bin/env -S npx tsx
import { config } from "./config.js";
import { getAccessToken } from "./auth.js";
import { SpotifyClient, RateLimitError } from "./spotify.js";
import { scanLibrary } from "./scan.js";
import { matchTrack } from "./match.js";
import { planGenre, applyGenre } from "./sync.js";
import { writeReport } from "./report.js";
import type { MatchResult } from "./types.js";

interface Flags {
  dryRun: boolean;
  threshold: number;
  concurrency: number;
  limit: number; // max fresh searches this run
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    dryRun: false,
    threshold: config.matchThreshold,
    concurrency: 3,
    limit: Number.POSITIVE_INFINITY,
  };
  for (const arg of argv) {
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg.startsWith("--threshold=")) flags.threshold = Number(arg.split("=")[1]);
    else if (arg.startsWith("--concurrency=")) flags.concurrency = Number(arg.split("=")[1]);
    else if (arg.startsWith("--limit=")) flags.limit = Number(arg.split("=")[1]);
  }
  return flags;
}

/** Run an async mapper over items with bounded concurrency. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  console.log(`Music root : ${config.musicRoot}`);
  console.log(`Threshold  : ${flags.threshold}`);
  console.log(`Mode       : ${flags.dryRun ? "DRY RUN (no changes)" : "MIRROR (add + remove)"}\n`);

  console.log("Scanning library...");
  const tracks = await scanLibrary(config.musicRoot);
  const genres = [...new Set(tracks.map((t) => t.genre))];
  console.log(`Found ${tracks.length} tracks across ${genres.length} genres.\n`);
  if (tracks.length === 0) return;

  const token = await getAccessToken();
  const client = new SpotifyClient(token);
  client.setSearchBudget(flags.limit);
  const me = await client.me();

  if (Number.isFinite(flags.limit)) {
    console.log(`Search budget: ${flags.limit} fresh lookups this run (cached tracks are free).`);
  }
  console.log("Matching against Spotify catalog...");
  let done = 0;
  const total = tracks.length;
  const results: MatchResult[] = await mapLimit(tracks, flags.concurrency, async (t) => {
    const r = await matchTrack(client, t, flags.threshold);
    done++;
    if (done % 20 === 0 || done === total) {
      process.stdout.write(`\r  ${done}/${total} processed`);
      client.saveCache(); // checkpoint so progress survives Ctrl+C
    }
    return r;
  });
  process.stdout.write("\n");
  client.saveCache();

  const matched = results.filter((r): r is Extract<MatchResult, { kind: "matched" }> => r.kind === "matched");
  const deferred = results.filter((r) => r.kind === "deferred").length;
  const skipped = results.length - matched.length - deferred;
  console.log(`Matched ${matched.length}, skipped ${skipped}, deferred ${deferred}.`);

  const reportPath = writeReport(results);
  if (reportPath) console.log(`Unmatched/skipped report: ${reportPath}`);

  // SAFETY: if any tracks were deferred (budget hit), matching is incomplete.
  // Syncing now would treat not-yet-matched tracks as removed in mirror mode.
  if (deferred > 0) {
    console.log(
      `\nMatching is incomplete — ${deferred} track(s) not yet looked up (daily quota).` +
        `\nProgress is cached. Re-run later to continue; sync is skipped until matching finishes` +
        `\nso it can't remove tracks that simply haven't been matched yet.`,
    );
    return;
  }

  // Group matched URIs by genre (dedupe within a playlist).
  const byGenre = new Map<string, string[]>();
  for (const m of matched) {
    const list = byGenre.get(m.local.genre) ?? [];
    if (!list.includes(m.track.uri)) list.push(m.track.uri);
    byGenre.set(m.local.genre, list);
  }

  console.log("");
  const playlists = await client.listMyPlaylists(me.id);

  for (const genre of genres) {
    const desired = byGenre.get(genre) ?? [];
    const { plan, playlistId } = await planGenre(client, me.id, genre, desired, playlists);
    const verb = playlistId ? "" : " (new)";
    console.log(
      `${plan.playlistName}${verb}: +${plan.toAdd.length} -${plan.toRemove.length} =${plan.keep}`,
    );
    if (!flags.dryRun) await applyGenre(client, me.id, plan, playlistId);
  }

  console.log(flags.dryRun ? "\nDry run complete — no changes made." : "\nSync complete.");
}

main().catch((err) => {
  if (err instanceof RateLimitError) {
    const hrs = (err.retryAfterSec / 3600).toFixed(1);
    console.error(
      `\nSpotify has temporarily blocked this app (cooldown ~${hrs}h).` +
        `\nProgress so far is cached, so re-running later resumes from where it stopped.` +
        `\nThis happens after too many rapid requests — wait for the cooldown, then try again.`,
    );
    process.exit(1);
  }
  console.error("\nError:", err.message);
  process.exit(1);
});
