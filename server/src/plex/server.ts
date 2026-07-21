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
  thumb: string | null;
};

export type AudioStream = {
  id: string;
  language: string | null;
  codec: string | null;
  channels: number | null;
  title: string | null;
  default: boolean;
};

export type SubtitleStream = {
  id: string;
  language: string | null;
  codec: string | null;
  title: string | null;
  forced: boolean;
  external: boolean;
  textBased: boolean;
};

export type PlaybackMeta = {
  durationMs: number | null;
  creditsOffsetMs: number | null;
  audio: AudioStream[];
  subtitle: SubtitleStream[];
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
      const thumb = (row as { thumb?: unknown }).thumb;
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
        thumb: typeof thumb === "string" ? thumb : null,
      });
    }

    result.sort(
      (a, b) =>
        a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber,
    );
    return result;
  }

  async function nextEpisode(
    episodeRatingKey: string,
  ): Promise<PlexEpisode | null> {
    const body = await getJson(`/library/metadata/${episodeRatingKey}`);
    const meta = firstMetadata(body);
    if (!meta) {
      throw new PlexServerUpstreamError(
        `Plex episode metadata missing for ${episodeRatingKey}`,
        502,
      );
    }

    const grandparent = meta.grandparentRatingKey;
    if (
      grandparent === undefined ||
      grandparent === null ||
      (typeof grandparent !== "string" && typeof grandparent !== "number")
    ) {
      return null;
    }

    const list = await episodes(String(grandparent));
    const idx = list.findIndex((ep) => ep.ratingKey === episodeRatingKey);
    if (idx < 0 || idx >= list.length - 1) {
      return null;
    }
    return list[idx + 1] ?? null;
  }

  async function playbackMeta(ratingKey: string): Promise<PlaybackMeta> {
    const body = await getJson(`/library/metadata/${ratingKey}`, {
      includeMarkers: "1",
    });
    const meta = firstMetadata(body);
    if (!meta) {
      throw new PlexServerUpstreamError(
        `Plex playback metadata missing for ${ratingKey}`,
        502,
      );
    }

    const durationMs =
      typeof meta.duration === "number" ? meta.duration : null;
    const creditsOffsetMs = creditsOffsetFromMarkers(meta.Marker);
    const audio: AudioStream[] = [];
    const subtitle: SubtitleStream[] = [];

    // Transcode URLs pin mediaIndex=0/partIndex=0, so only expose streams from
    // the first Media's first Part — later versions would map to the wrong ids.
    const medium = asArray(meta.Media)[0];
    const part =
      typeof medium === "object" && medium !== null
        ? asArray((medium as { Part?: unknown }).Part)[0]
        : undefined;
    const streams =
      typeof part === "object" && part !== null
        ? asArray((part as { Stream?: unknown }).Stream)
        : [];

    for (const stream of streams) {
      if (typeof stream !== "object" || stream === null) {
        continue;
      }
      const row = stream as {
        id?: unknown;
        streamType?: unknown;
        language?: unknown;
        codec?: unknown;
        channels?: unknown;
        title?: unknown;
        default?: unknown;
        forced?: unknown;
        key?: unknown;
      };
      if (row.id === undefined || row.id === null) {
        continue;
      }
      const id = String(row.id);
      const language =
        typeof row.language === "string" ? row.language : null;
      const codec = typeof row.codec === "string" ? row.codec : null;
      const title = typeof row.title === "string" ? row.title : null;

      if (row.streamType === 2) {
        audio.push({
          id,
          language,
          codec,
          channels: typeof row.channels === "number" ? row.channels : null,
          title,
          default: plexBool(row.default),
        });
      } else if (row.streamType === 3) {
        subtitle.push({
          id,
          language,
          codec,
          title,
          forced: plexBool(row.forced),
          external: typeof row.key === "string" && row.key.length > 0,
          // Heuristic: text-based codecs that can become sidecar VTT.
          // Unknown codecs are treated as non-text (image/burn-in).
          textBased: isTextBasedSubtitleCodec(codec),
        });
      }
    }

    return { durationMs, creditsOffsetMs, audio, subtitle };
  }

  return { accounts, history, item, episodes, nextEpisode, playbackMeta };
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
): {
  title?: unknown;
  Media?: unknown;
  duration?: unknown;
  grandparentRatingKey?: unknown;
  Marker?: unknown;
} | null {
  const rows = asArray(mediaContainer(body)?.Metadata);
  const first = rows[0];
  if (typeof first !== "object" || first === null) {
    return null;
  }
  return first as {
    title?: unknown;
    Media?: unknown;
    duration?: unknown;
    grandparentRatingKey?: unknown;
    Marker?: unknown;
  };
}

// Prefer final credits; else the credits marker with the greatest start.
// Missing/malformed markers soft-fail to null — never throw.
function creditsOffsetFromMarkers(markers: unknown): number | null {
  let finalOffset: number | null = null;
  let latestOffset: number | null = null;

  for (const row of asArray(markers)) {
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const marker = row as {
      type?: unknown;
      startTimeOffset?: unknown;
      final?: unknown;
    };
    if (marker.type !== "credits") {
      continue;
    }
    const offset = marker.startTimeOffset;
    if (
      typeof offset !== "number" ||
      !Number.isFinite(offset) ||
      offset < 0
    ) {
      continue;
    }
    if (latestOffset === null || offset > latestOffset) {
      latestOffset = offset;
    }
    if (plexBool(marker.final)) {
      if (finalOffset === null || offset > finalOffset) {
        finalOffset = offset;
      }
    }
  }

  return finalOffset ?? latestOffset;
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

function plexBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function isTextBasedSubtitleCodec(codec: string | null): boolean {
  if (codec === null) {
    return false;
  }
  switch (codec.toLowerCase()) {
    case "srt":
    case "subrip":
    case "ass":
    case "ssa":
    case "mov_text":
    case "webvtt":
    case "text":
      return true;
    default:
      return false;
  }
}
