import type { LocalTrack, MatchResult, SpotifyTrack } from "./types.js";
import { RateLimitError, BudgetExhaustedError, type SpotifyClient } from "./spotify.js";

/**
 * Normalize for comparison: lowercase, strip feat collaborators, short country/platform
 * codes like (BR)/(ofc)/(Aus), and bare version labels like "(Extended Mix)" /
 * "(Original Mix)" (Spotify often omits these), then unparenthesize remaining
 * content so "(Alan Dixon Remix)" stays as "alan dixon remix".
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(feat\.?[^)]*\)|\bfeat\.?\b.*$|\bft\.?\b.*$/g, "")
    .replace(/\([a-z]{2,5}\)/g, "")  // strip Beatport-style codes: (br), (ofc), (aus) …
    .replace(/\((extended|original|radio)\s*(mix|version|edit)?\s*\)/g, "") // strip version labels
    .replace(/-\s*(extended|original|radio)\s*(mix|version|edit)?\s*$/g, "") // same after dash
    .replace(/[()[\]]/g, " ")         // unparenthesize rest, preserving remix/rework content
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Title cleaned for Spotify search queries: strip feat. and bare version suffixes
 * that Spotify doesn't treat as separate fields (Extended Mix, Original Mix, etc.)
 * but keep remix/rework names since they narrow results.
 */
function queryTitle(title: string): string {
  const cleaned = title
    .replace(/\s*\(feat\.?[^)]*\)/gi, "")
    .replace(/\bfeat\.?\s+\S[^([,]*/gi, "")
    .replace(/\s*\((extended|original|radio)\s*(mix|version|edit)?\s*\)/gi, "")
    .replace(/\s*-\s*(extended|original|radio)\s*(mix|version|edit)?\s*$/gi, "")
    .trim();
  return cleaned || title;
}

/**
 * First artist only, with Beatport-style disambiguation suffixes stripped:
 * (BR), (Aus), (ofc), (SA), (BE), (BG), (FR), (IT), etc.
 */
function queryArtist(artist: string): string {
  const first = artist.split(",")[0]!.trim();
  return first.replace(/\s*\([A-Za-z]{2,5}\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

/** Sørensen–Dice coefficient over character bigrams (0..1), dependency-free. */
function diceSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigrams(na);
  const mb = bigrams(nb);
  let overlap = 0;
  for (const [g, count] of ma) overlap += Math.min(count, mb.get(g) ?? 0);
  const total = na.length - 1 + (nb.length - 1);
  return (2 * overlap) / total;
}

/**
 * Combined score: 60% title, 40% best pairwise artist match.
 * Splits comma-separated local artists so each is compared individually against
 * each Spotify artist — avoids penalising multi-artist tracks.
 */
function score(local: LocalTrack, candidate: SpotifyTrack): number {
  const titleScore = diceSimilarity(local.title, candidate.name);

  let artistScore: number;
  if (!local.artist) {
    artistScore = 0.5;
  } else {
    const localArtists = local.artist.split(",").map((a) => a.trim());
    artistScore = 0;
    for (const la of localArtists) {
      for (const sa of candidate.artists) {
        const s = diceSimilarity(la, sa);
        if (s > artistScore) artistScore = s;
      }
    }
  }

  return 0.6 * titleScore + 0.4 * artistScore;
}

export async function matchTrack(
  client: SpotifyClient,
  local: LocalTrack,
  threshold: number,
): Promise<MatchResult> {
  const qt = queryTitle(local.title);
  const qa = local.artist ? queryArtist(local.artist) || null : null;

  // Phase 1 — cache-only scan, zero budget consumed.
  // Checks the new cleaned format AND the old raw format so pre-existing cache
  // entries are reused even though the query strings changed between versions.
  const oldFormat = local.artist
    ? `track:${local.title} artist:${local.artist}`
    : `track:${local.title}`;

  const cacheFormats: string[] = qa
    ? [`track:${qt} artist:${qa}`, oldFormat, `${qt} ${qa}`, qt]
    : [`track:${qt}`, oldFormat, qt];

  let candidates: SpotifyTrack[] = [];
  for (const query of cacheFormats) {
    const hit = client.peekCache(query);
    if (hit !== undefined && hit.length > 0) {
      candidates = hit;
      break;
    }
  }

  // Phase 2 — fresh API queries only when cache has nothing usable.
  if (candidates.length === 0) {
    const apiQueries: string[] = qa
      ? [`track:${qt} artist:${qa}`, `${qt} ${qa}`, qt]
      : [`track:${qt}`, qt];

    for (const query of apiQueries) {
      try {
        candidates = await client.searchTrack(query);
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
        if (e instanceof BudgetExhaustedError) return { kind: "deferred", local };
        return { kind: "skipped", local, reason: `search error: ${(e as Error).message}`, score: 0 };
      }
      if (candidates.length > 0) break;
    }
  }

  if (candidates.length === 0) {
    return { kind: "skipped", local, reason: "no search results", score: 0 };
  }

  let best = candidates[0]!;
  let bestScore = score(local, best);
  for (const c of candidates.slice(1)) {
    const s = score(local, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }

  if (bestScore >= threshold) {
    return { kind: "matched", local, track: best, score: Number(bestScore.toFixed(3)) };
  }
  return {
    kind: "skipped",
    local,
    reason: `low confidence (best: ${best.artists.join(", ")} - ${best.name})`,
    score: Number(bestScore.toFixed(3)),
  };
}
