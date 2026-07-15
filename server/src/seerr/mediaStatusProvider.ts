import {
  mediaStatusFromCode,
  type MediaAvailability,
  type SeerrClient,
} from "./client";

const MEDIA_STATUS_TTL_MS = 60_000;

export type MediaStatusProvider = {
  getStatusMap(): Promise<ReadonlyMap<string, MediaAvailability>>;
  getMediaId(
    mediaType: "movie" | "tv",
    tmdbId: number,
  ): Promise<number | null>;
};

export function createMediaStatusProvider(
  seerr: Pick<SeerrClient, "listMedia">,
): MediaStatusProvider {
  let cache:
    | {
        expiresAt: number;
        statuses: ReadonlyMap<string, MediaAvailability>;
        mediaIds: ReadonlyMap<string, number>;
      }
    | undefined;

  async function loadCache(): Promise<typeof cache> {
    if (cache !== undefined && cache.expiresAt > Date.now()) {
      return cache;
    }

    try {
      const media = await seerr.listMedia();
      const statuses = new Map<string, MediaAvailability>();
      const mediaIds = new Map<string, number>();
      for (const item of media) {
        const key = `${item.mediaType}:${item.tmdbId}`;
        mediaIds.set(key, item.id);
        const status = mediaStatusFromCode(item.status);
        if (status !== null) {
          statuses.set(key, status);
        }
      }
      cache = {
        expiresAt: Date.now() + MEDIA_STATUS_TTL_MS,
        statuses,
        mediaIds,
      };
      return cache;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Seerr media list request failed";
      console.error(`Unable to load Seerr media statuses: ${message}`);
      return undefined;
    }
  }

  async function getStatusMap(): Promise<
    ReadonlyMap<string, MediaAvailability>
  > {
    return (await loadCache())?.statuses ?? new Map();
  }

  async function getMediaId(
    mediaType: "movie" | "tv",
    tmdbId: number,
  ): Promise<number | null> {
    return (await loadCache())?.mediaIds.get(`${mediaType}:${tmdbId}`) ?? null;
  }

  return { getStatusMap, getMediaId };
}
