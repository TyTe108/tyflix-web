import type { MediaType } from "./discover";
import type { MediaAvailabilityStatus } from "./requests";

export type WatchlistItem = {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  posterUrl: string | null;
  mediaStatus: MediaAvailabilityStatus | null;
};

export async function fetchWatchlist(): Promise<WatchlistItem[]> {
  const res = await fetch("/api/watchlist");
  if (!res.ok) {
    throw new Error(`Failed to load watchlist (${res.status})`);
  }
  const body = (await res.json()) as { results: WatchlistItem[] };
  return body.results;
}
