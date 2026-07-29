// Cached batch lookup of a title and poster for a list of TMDB ids.
//
// Seerr's rows carry ids but no artwork, so anything showing Seerr data needs
// a TMDB round trip per title before it can render a card. The watchlist and
// issues routers both call this with a whole page of items at once. It exists
// so that showing twenty requests doesn't mean twenty uncached TMDB calls every
// time someone refreshes.
//
// The cache is in-process and unbounded, which is fine at household scale.
// Titles and posters barely change, so the ten-minute TTL is generous on
// purpose.

import type { TmdbClient } from "./client";

export type MediaEnrichmentItem = {
  mediaType: "movie" | "tv";
  tmdbId: number;
};

export type MediaEnrichmentValue = {
  title: string;
  posterUrl: string | null;
};

// Deliberately narrow. Routers depend on this interface rather than the
// concrete factory, which is what lets tests pass a stub.
export type MediaEnrichment = {
  enrich(
    items: MediaEnrichmentItem[],
  ): Promise<Map<string, MediaEnrichmentValue>>;
};

const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Builds the enrichment cache. One instance at startup, shared by every router
 * that needs it, so they share the cached entries too.
 */
export function createMediaEnrichment(
  tmdb: Pick<TmdbClient, "movieDetail" | "tvDetail">,
): MediaEnrichment {
  const cache = new Map<
    string,
    { value: MediaEnrichmentValue; expiresAt: number }
  >();

  /**
   * Resolves titles and posters for a batch, keyed `${mediaType}:${tmdbId}`.
   *
   * @returns a map that may be smaller than the input. A key is missing when
   * that lookup failed, so callers have to handle absence rather than assume a
   * one-to-one mapping.
   */
  async function enrich(
    items: MediaEnrichmentItem[],
  ): Promise<Map<string, MediaEnrichmentValue>> {
    const now = Date.now();
    // Collapse duplicates first. A requests page routinely lists the same show
    // several times, and each distinct title should only be fetched once.
    const unique = new Map<string, MediaEnrichmentItem>();
    for (const item of items) {
      unique.set(mediaEnrichmentKey(item), item);
    }

    // Split into cache hits and the work still to do. Expired entries are
    // deleted on the way past, which is the only eviction this cache has.
    const result = new Map<string, MediaEnrichmentValue>();
    const missing: Array<[string, MediaEnrichmentItem]> = [];
    for (const [key, item] of unique) {
      const cached = cache.get(key);
      if (cached !== undefined && cached.expiresAt > now) {
        result.set(key, cached.value);
      } else {
        cache.delete(key);
        missing.push([key, item]);
      }
    }

    // Fetch the misses in parallel. Latency here is one TMDB round trip rather
    // than one per title, which is the whole reason this takes a batch.
    await Promise.all(
      missing.map(async ([key, item]) => {
        try {
          const detail =
            item.mediaType === "movie"
              ? await tmdb.movieDetail(item.tmdbId)
              : await tmdb.tvDetail(item.tmdbId);
          const value = {
            title: detail.title,
            posterUrl: detail.posterUrl,
          };
          cache.set(key, {
            value,
            expiresAt: Date.now() + CACHE_TTL_MS,
          });
          result.set(key, value);
        } catch {
          // A single failed lookup must not prevent other media from enriching.
          // Failures aren't cached either, so the next call retries.
        }
      }),
    );

    return result;
  }

  return { enrich };
}

/**
 * The cache and result key. Same `${mediaType}:${tmdbId}` convention as
 * mediaStatusProvider, so a caller holding both maps can use one key for both.
 */
export function mediaEnrichmentKey(item: MediaEnrichmentItem): string {
  return `${item.mediaType}:${item.tmdbId}`;
}
