import { playlistNameFor } from "./config.js";
import type { SpotifyClient } from "./spotify.js";
import type { SyncPlan } from "./types.js";

/** Compute add/remove diff to make the playlist exactly equal to `desiredUris`. */
export async function planGenre(
  client: SpotifyClient,
  userId: string,
  genre: string,
  desiredUris: string[],
  existingPlaylists: { id: string; name: string }[],
): Promise<{ plan: SyncPlan; playlistId: string | null }> {
  const playlistName = playlistNameFor(genre);
  const existing = existingPlaylists.find((p) => p.name === playlistName);
  const desired = new Set(desiredUris);

  if (!existing) {
    return {
      plan: { genre, playlistName, toAdd: [...desired], toRemove: [], keep: 0 },
      playlistId: null,
    };
  }

  const current = new Set(await client.playlistTrackUris(existing.id));
  const toAdd = [...desired].filter((u) => !current.has(u));
  const toRemove = [...current].filter((u) => !desired.has(u));
  const keep = [...desired].filter((u) => current.has(u)).length;
  return { plan: { genre, playlistName, toAdd, toRemove, keep }, playlistId: existing.id };
}

export async function applyGenre(
  client: SpotifyClient,
  userId: string,
  plan: SyncPlan,
  playlistId: string | null,
): Promise<void> {
  let id = playlistId;
  if (!id) {
    if (plan.toAdd.length === 0) return;
    id = await client.createPlaylist(userId, plan.playlistName);
  }
  if (plan.toRemove.length) await client.removeTracks(id, plan.toRemove);
  if (plan.toAdd.length) await client.addTracks(id, plan.toAdd);
}
