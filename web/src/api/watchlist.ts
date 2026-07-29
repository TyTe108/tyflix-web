// Client for the server's watchlist router (server/src/routes/watchlist.ts),
// mounted at /api/watchlist behind requireAuth. One endpoint, and it's the
// smallest file in api/.
//
// Plex owns the watchlist, but Seerr already mirrors it per user, so the server
// reads Seerr rather than making a second trip to plex.tv. It then stitches in
// availability from Seerr's media table and posters from TMDB, because the
// watchlist rows come back as little more than ids.
//
// Errors follow the api/discover.ts convention: throw on non-2xx.

import type { MediaType } from "./discover";
import type { MediaAvailabilityStatus } from "./requests";

// A watchlist row, already annotated and enriched server-side. posterUrl is
// null when the TMDB lookup missed, which doesn't fail the request.
export type WatchlistItem = {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  posterUrl: string | null;
  mediaStatus: MediaAvailabilityStatus | null;
};

/**
 * GET /api/watchlist. The signed-in user's Plex Watchlist.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchWatchlist(): Promise<WatchlistItem[]> {
  const res = await fetch("/api/watchlist");
  if (!res.ok) {
    throw new Error(`Failed to load watchlist (${res.status})`);
  }
  const body = (await res.json()) as { results: WatchlistItem[] };
  return body.results;
}
