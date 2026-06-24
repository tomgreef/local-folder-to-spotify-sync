export interface LocalTrack {
  /** Genre derived from the top-level folder name. */
  genre: string;
  artist: string;
  title: string;
  album?: string;
  /** Absolute path on disk, used for the report. */
  path: string;
}

export interface SpotifyTrack {
  uri: string;
  name: string;
  artists: string[];
}

export type MatchResult =
  | { kind: "matched"; local: LocalTrack; track: SpotifyTrack; score: number }
  | { kind: "skipped"; local: LocalTrack; reason: string; score: number }
  | { kind: "deferred"; local: LocalTrack };

export interface SyncPlan {
  genre: string;
  playlistName: string;
  toAdd: string[]; // URIs
  toRemove: string[]; // URIs
  keep: number;
}
