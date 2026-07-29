// The join point between the app's two id systems.
//
// Discovery is keyed by TMDB id. Plex is keyed by its own ratingKey. Seerr's
// media table is the only thing that knows which is which, so this file pulls
// that table once a minute and turns it into three lookups: is this title
// available, what's its Seerr media id, and what's its Plex ratingKey.
//
// A lot of the apparent complexity elsewhere in the codebase is that join.
// /api/discover asks it for availability badges, /api/watch asks it for the
// ratingKey before it can mint a playback URL, and /api/issues asks it for the
// Seerr media id before it can file a report. Every one of those is keyed on
// "movie:603" or "tv:1396".
//
// Failure is soft on purpose. If Seerr is down, discovery still renders with no
// availability badges instead of returning a 502 for the whole page.

import {
  mediaStatusFromCode,
  type MediaAvailability,
  type SeerrClient,
} from "./client";

// One minute is the compromise: /api/v1/media is fully paged on every refresh,
// but a title that just finished downloading shouldn't stay un-playable for
// long.
const MEDIA_STATUS_TTL_MS = 60_000;

// The three lookups routers depend on. Keys are `${mediaType}:${tmdbId}`.
export type MediaStatusProvider = {
  getStatusMap(): Promise<ReadonlyMap<string, MediaAvailability>>;
  getMediaId(
    mediaType: "movie" | "tv",
    tmdbId: number,
  ): Promise<number | null>;
  getRatingKey(
    mediaType: "movie" | "tv",
    tmdbId: number,
  ): Promise<string | null>;
};

/**
 * Builds the cached TMDB-to-Plex resolver. One instance is shared by the four
 * routers that need it (discover, watchlist, issues and watch), so they share
 * the cache too.
 *
 * Takes only the piece of the Seerr client it needs, which is what lets the
 * tests hand it a plain object with a listMedia method and nothing else.
 */
export function createMediaStatusProvider(
  seerr: Pick<SeerrClient, "listMedia">,
): MediaStatusProvider {
  // All three maps are built from the same page walk and expire together, so
  // they can never disagree about a title.
  let cache:
    | {
        expiresAt: number;
        statuses: ReadonlyMap<string, MediaAvailability>;
        mediaIds: ReadonlyMap<string, number>;
        ratingKeys: ReadonlyMap<string, string>;
      }
    | undefined;

  // Returns the cache, refreshing it if it's stale, or undefined when Seerr
  // can't be reached. No in-flight deduplication here: two concurrent misses
  // will each hit Seerr.
  async function loadCache(): Promise<typeof cache> {
    if (cache !== undefined && cache.expiresAt > Date.now()) {
      return cache;
    }

    try {
      const media = await seerr.listMedia();
      const statuses = new Map<string, MediaAvailability>();
      const mediaIds = new Map<string, number>();
      const ratingKeys = new Map<string, string>();
      // Three maps, one pass. A title always gets a mediaId, but the other two
      // entries are conditional: no Plex ratingKey means nothing to play, and
      // an unrecognized status code is left out entirely so the UI falls back
      // to "not tracked" instead of showing something wrong.
      for (const item of media) {
        const key = `${item.mediaType}:${item.tmdbId}`;
        mediaIds.set(key, item.id);
        if (item.ratingKey !== null) {
          ratingKeys.set(key, item.ratingKey);
        }
        const status = mediaStatusFromCode(item.status);
        if (status !== null) {
          statuses.set(key, status);
        }
      }
      cache = {
        expiresAt: Date.now() + MEDIA_STATUS_TTL_MS,
        statuses,
        mediaIds,
        ratingKeys,
      };
      return cache;
    } catch (err) {
      // Swallow and log. The old cache isn't reused here, so a Seerr outage
      // degrades to "nothing is tracked" rather than serving stale badges.
      const message =
        err instanceof Error ? err.message : "Seerr media list request failed";
      console.error(`Unable to load Seerr media statuses: ${message}`);
      return undefined;
    }
  }

  /**
   * Availability for every tracked title, keyed `${mediaType}:${tmdbId}`.
   *
   * @returns an empty map when Seerr is unreachable, so callers can annotate
   * discovery results without a try/catch around every page.
   */
  async function getStatusMap(): Promise<
    ReadonlyMap<string, MediaAvailability>
  > {
    return (await loadCache())?.statuses ?? new Map();
  }

  /**
   * Seerr's internal media id for a TMDB id, which is what the issue API wants.
   *
   * @returns null when Seerr isn't tracking the title (or is unreachable). The
   * issues route turns that into a 404.
   */
  async function getMediaId(
    mediaType: "movie" | "tv",
    tmdbId: number,
  ): Promise<number | null> {
    return (await loadCache())?.mediaIds.get(`${mediaType}:${tmdbId}`) ?? null;
  }

  /**
   * The Plex ratingKey for a TMDB id. This is the lookup that makes playback
   * possible at all, since /api/watch can't build a stream URL without it.
   *
   * @returns null when the title has no Plex match, which the watch route
   * reports as "not playable".
   */
  async function getRatingKey(
    mediaType: "movie" | "tv",
    tmdbId: number,
  ): Promise<string | null> {
    return (
      (await loadCache())?.ratingKeys.get(`${mediaType}:${tmdbId}`) ?? null
    );
  }

  return { getStatusMap, getMediaId, getRatingKey };
}
