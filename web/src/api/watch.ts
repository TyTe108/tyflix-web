export type WatchConnections = {
  local: string | null;
  remote: string;
};

export type WatchHls = {
  local: string | null;
  remote: string;
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

// Local to the watch flow: the backend only ever plays movies or episodes, and
// episodes carry no tmdbId (they're keyed on a raw Plex ratingKey).
export type WatchMediaType = "movie" | "episode";

export type WatchDescriptor = {
  mediaType: WatchMediaType;
  tmdbId?: number;
  ratingKey: string;
  connections: WatchConnections;
  transient: string;
  hls: WatchHls;
  sessionId: string;
  streams: { audio: AudioStream[]; subtitle: SubtitleStream[] };
  durationMs: number | null;
  creditsOffsetMs: number | null;
  partId: string | null;
};

export type WatchTuning = {
  maxVideoBitrate?: number;
  videoResolution?: string;
  offset?: number;
  audioStreamID?: string;
};

export async function fetchMovieWatch(
  tmdbId: number,
  tuning?: WatchTuning,
): Promise<WatchDescriptor> {
  return fetchWatch(`/api/watch/movie/${tmdbId}`, tuning);
}

export async function fetchEpisodeWatch(
  ratingKey: string,
  tuning?: WatchTuning,
): Promise<WatchDescriptor> {
  return fetchWatch(`/api/watch/episode/${ratingKey}`, tuning);
}

export type Episode = {
  ratingKey: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
};

export type NextEpisode = {
  ratingKey: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  thumb: string | null;
};

export type EpisodesResponse = {
  showRatingKey: string;
  episodes: Episode[];
};

export async function fetchEpisodes(
  tmdbId: number,
): Promise<EpisodesResponse> {
  const res = await fetch(`/api/watch/tv/${tmdbId}/episodes`);
  if (!res.ok) {
    // Surface the backend's { error } message when present (e.g. 404 "not
    // playable") so the UI can show why.
    const message = await readErrorMessage(res);
    throw new Error(message ?? `Failed to load episodes (${res.status})`);
  }
  const body = (await res.json()) as {
    showRatingKey?: unknown;
    episodes?: unknown;
  };
  return {
    showRatingKey: String(body.showRatingKey ?? ""),
    episodes: Array.isArray(body.episodes)
      ? (body.episodes as Episode[])
      : [],
  };
}

// Soft-fail: a missing/failed/malformed next episode must never break playback.
export async function fetchNextEpisode(
  ratingKey: string,
): Promise<NextEpisode | null> {
  try {
    const res = await fetch(`/api/watch/episode/${ratingKey}/next`);
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { nextEpisode?: unknown };
    return parseNextEpisode(body.nextEpisode);
  } catch {
    return null;
  }
}

function parseNextEpisode(value: unknown): NextEpisode | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as {
    ratingKey?: unknown;
    seasonNumber?: unknown;
    episodeNumber?: unknown;
    title?: unknown;
    thumb?: unknown;
  };
  if (
    typeof row.ratingKey !== "string" ||
    typeof row.seasonNumber !== "number" ||
    typeof row.episodeNumber !== "number" ||
    typeof row.title !== "string"
  ) {
    return null;
  }
  return {
    ratingKey: row.ratingKey,
    seasonNumber: row.seasonNumber,
    episodeNumber: row.episodeNumber,
    title: row.title,
    thumb: typeof row.thumb === "string" ? row.thumb : null,
  };
}

async function fetchWatch(
  path: string,
  tuning?: WatchTuning,
): Promise<WatchDescriptor> {
  const params = new URLSearchParams();
  if (tuning?.maxVideoBitrate !== undefined) {
    params.set("maxVideoBitrate", String(tuning.maxVideoBitrate));
  }
  if (tuning?.videoResolution !== undefined) {
    params.set("videoResolution", tuning.videoResolution);
  }
  if (tuning?.offset !== undefined) {
    params.set("offset", String(tuning.offset));
  }
  if (tuning?.audioStreamID !== undefined) {
    params.set("audioStreamID", tuning.audioStreamID);
  }
  const qs = params.toString();
  const res = await fetch(qs.length > 0 ? `${path}?${qs}` : path);
  if (!res.ok) {
    // Surface the backend's { error } message when present (e.g. 404 "not
    // playable", 409 "re-login required") so the UI can show why.
    const message = await readErrorMessage(res);
    throw new Error(message ?? `Failed to load stream (${res.status})`);
  }
  return (await res.json()) as WatchDescriptor;
}

async function readErrorMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}
