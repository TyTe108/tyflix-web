export class PlexServerUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PlexServerUpstreamError";
    this.status = status;
  }
}

export type PlexServerClientOptions = {
  baseUrl: string;
  token: string;
};

export type PlexWatchedSets = {
  movies: Set<string>;
  episodes: Set<string>;
};

export type PlexEpisodeLeaf = {
  rk: string;
  sizeBytes: number;
  season: number;
};

export type PlexItem = {
  title: string;
  sizeBytes: number;
  episodes: PlexEpisodeLeaf[] | null;
};

export type PlexEpisode = {
  ratingKey: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
};

export function createPlexServerClient(options: PlexServerClientOptions) {
  const { baseUrl, token } = options;
  const itemCache = new Map<string, PlexItem>();

  async function getJson(path: string, query?: Record<string, string>): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "X-Plex-Token": token,
          Accept: "application/json",
        },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Plex server request failed";
      throw new PlexServerUpstreamError(message, 502);
    }

    if (!res.ok) {
      throw new PlexServerUpstreamError(
        `Plex server ${path} failed (${res.status})`,
        res.status,
      );
    }

    return res.json();
  }

  async function accounts(): Promise<Map<number, string>> {
    const body = await getJson("/accounts");
    const container = mediaContainer(body);
    const rows = asArray(container?.Account);
    const map = new Map<number, string>();

    for (const row of rows) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const id = (row as { id?: unknown }).id;
      const name = (row as { name?: unknown }).name;
      if (typeof id === "number" && typeof name === "string") {
        map.set(id, name);
      }
    }

    return map;
  }

  async function history(): Promise<Map<number, PlexWatchedSets>> {
    const pageSize = 500;
    let start = 0;
    let totalSize = Number.POSITIVE_INFINITY;
    const map = new Map<number, PlexWatchedSets>();

    while (start < totalSize) {
      const body = await getJson("/status/sessions/history/all", {
        "X-Plex-Container-Start": String(start),
        "X-Plex-Container-Size": String(pageSize),
        sort: "viewedAt:desc",
      });

      const container = mediaContainer(body);
      if (typeof container?.totalSize === "number") {
        totalSize = container.totalSize;
      } else if (start === 0) {
        totalSize = 0;
      }

      const metadata = asArray(container?.Metadata);
      for (const row of metadata) {
        if (typeof row !== "object" || row === null) {
          continue;
        }
        const accountID = (row as { accountID?: unknown }).accountID;
        const type = (row as { type?: unknown }).type;
        const ratingKey = (row as { ratingKey?: unknown }).ratingKey;
        if (typeof accountID !== "number") {
          continue;
        }
        if (typeof type !== "string") {
          continue;
        }
        if (ratingKey === undefined || ratingKey === null) {
          continue;
        }

        let sets = map.get(accountID);
        if (!sets) {
          sets = { movies: new Set(), episodes: new Set() };
          map.set(accountID, sets);
        }

        const key = String(ratingKey);
        if (type === "movie") {
          sets.movies.add(key);
        } else if (type === "episode") {
          sets.episodes.add(key);
        }
      }

      if (metadata.length === 0) {
        break;
      }
      start += pageSize;
    }

    return map;
  }

  async function item(ratingKey: string, isShow: boolean): Promise<PlexItem> {
    const cacheKey = `${ratingKey}:${isShow ? "1" : "0"}`;
    const cached = itemCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = isShow
      ? await fetchShow(ratingKey)
      : await fetchMovie(ratingKey);
    itemCache.set(cacheKey, result);
    return result;
  }

  async function fetchMovie(ratingKey: string): Promise<PlexItem> {
    const body = await getJson(`/library/metadata/${ratingKey}`);
    const meta = firstMetadata(body);
    if (!meta) {
      throw new PlexServerUpstreamError(
        `Plex movie metadata missing for ${ratingKey}`,
        502,
      );
    }
    const title = typeof meta.title === "string" ? meta.title : "";
    const sizeBytes = sumMediaPartSizes(meta.Media);
    return { title, sizeBytes, episodes: null };
  }

  async function fetchShow(ratingKey: string): Promise<PlexItem> {
    const showBody = await getJson(`/library/metadata/${ratingKey}`);
    const showMeta = firstMetadata(showBody);
    const title =
      showMeta && typeof showMeta.title === "string" ? showMeta.title : "";

    const leavesBody = await getJson(
      `/library/metadata/${ratingKey}/allLeaves`,
    );
    const leaves = asArray(mediaContainer(leavesBody)?.Metadata);
    const episodes: PlexEpisodeLeaf[] = [];
    let sizeBytes = 0;

    for (const row of leaves) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const rk = (row as { ratingKey?: unknown }).ratingKey;
      const season = (row as { parentIndex?: unknown }).parentIndex;
      if (rk === undefined || rk === null || typeof season !== "number") {
        continue;
      }
      const epSize = sumMediaPartSizes((row as { Media?: unknown }).Media);
      episodes.push({ rk: String(rk), sizeBytes: epSize, season });
      sizeBytes += epSize;
    }

    return { title, sizeBytes, episodes };
  }

  async function episodes(showRatingKey: string): Promise<PlexEpisode[]> {
    const leavesBody = await getJson(
      `/library/metadata/${showRatingKey}/allLeaves`,
    );
    const leaves = asArray(mediaContainer(leavesBody)?.Metadata);
    const result: PlexEpisode[] = [];

    for (const row of leaves) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const rk = (row as { ratingKey?: unknown }).ratingKey;
      const season = (row as { parentIndex?: unknown }).parentIndex;
      const episode = (row as { index?: unknown }).index;
      const title = (row as { title?: unknown }).title;
      if (
        rk === undefined ||
        rk === null ||
        typeof season !== "number" ||
        typeof episode !== "number"
      ) {
        continue;
      }
      result.push({
        ratingKey: String(rk),
        seasonNumber: season,
        episodeNumber: episode,
        title: typeof title === "string" ? title : "",
      });
    }

    result.sort(
      (a, b) =>
        a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber,
    );
    return result;
  }

  return { accounts, history, item, episodes };
}

export type PlexServerClient = ReturnType<typeof createPlexServerClient>;

function mediaContainer(
  body: unknown,
): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const container = (body as { MediaContainer?: unknown }).MediaContainer;
  if (typeof container !== "object" || container === null) {
    return null;
  }
  return container as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function firstMetadata(
  body: unknown,
): { title?: unknown; Media?: unknown } | null {
  const rows = asArray(mediaContainer(body)?.Metadata);
  const first = rows[0];
  if (typeof first !== "object" || first === null) {
    return null;
  }
  return first as { title?: unknown; Media?: unknown };
}

function sumMediaPartSizes(media: unknown): number {
  let total = 0;
  for (const medium of asArray(media)) {
    if (typeof medium !== "object" || medium === null) {
      continue;
    }
    for (const part of asArray((medium as { Part?: unknown }).Part)) {
      if (typeof part !== "object" || part === null) {
        continue;
      }
      const size = (part as { size?: unknown }).size;
      if (typeof size === "number") {
        total += size;
      }
    }
  }
  return total;
}
