import {
  mediaStatusFromCode,
  type MediaAvailability,
  type SeerrClient,
} from "./client";

const MEDIA_STATUS_TTL_MS = 60_000;

export type MediaStatusProvider = {
  getStatusMap(): Promise<ReadonlyMap<string, MediaAvailability>>;
};

export function createMediaStatusProvider(
  seerr: Pick<SeerrClient, "listMedia">,
): MediaStatusProvider {
  let cache:
    | {
        expiresAt: number;
        statuses: ReadonlyMap<string, MediaAvailability>;
      }
    | undefined;

  async function getStatusMap(): Promise<
    ReadonlyMap<string, MediaAvailability>
  > {
    if (cache !== undefined && cache.expiresAt > Date.now()) {
      return cache.statuses;
    }

    try {
      const media = await seerr.listMedia();
      const statuses = new Map<string, MediaAvailability>();
      for (const item of media) {
        const status = mediaStatusFromCode(item.status);
        if (status !== null) {
          statuses.set(`${item.mediaType}:${item.tmdbId}`, status);
        }
      }
      cache = {
        expiresAt: Date.now() + MEDIA_STATUS_TTL_MS,
        statuses,
      };
      return statuses;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Seerr media list request failed";
      console.error(`Unable to load Seerr media statuses: ${message}`);
      return new Map();
    }
  }

  return { getStatusMap };
}
