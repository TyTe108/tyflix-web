import type { TmdbClient } from "./client";

export type MediaEnrichmentItem = {
  mediaType: "movie" | "tv";
  tmdbId: number;
};

export type MediaEnrichmentValue = {
  title: string;
  posterUrl: string | null;
};

export type MediaEnrichment = {
  enrich(
    items: MediaEnrichmentItem[],
  ): Promise<Map<string, MediaEnrichmentValue>>;
};

const CACHE_TTL_MS = 10 * 60 * 1000;

export function createMediaEnrichment(
  tmdb: Pick<TmdbClient, "movieDetail" | "tvDetail">,
): MediaEnrichment {
  const cache = new Map<
    string,
    { value: MediaEnrichmentValue; expiresAt: number }
  >();

  async function enrich(
    items: MediaEnrichmentItem[],
  ): Promise<Map<string, MediaEnrichmentValue>> {
    const now = Date.now();
    const unique = new Map<string, MediaEnrichmentItem>();
    for (const item of items) {
      unique.set(mediaEnrichmentKey(item), item);
    }

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
        }
      }),
    );

    return result;
  }

  return { enrich };
}

export function mediaEnrichmentKey(item: MediaEnrichmentItem): string {
  return `${item.mediaType}:${item.tmdbId}`;
}
