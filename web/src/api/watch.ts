import type { MediaType } from "./discover";

export type WatchConnections = {
  local: string | null;
  remote: string;
};

export type WatchHls = {
  local: string | null;
  remote: string;
};

export type WatchDescriptor = {
  mediaType: MediaType;
  tmdbId: number;
  ratingKey: string;
  connections: WatchConnections;
  transient: string;
  hls: WatchHls;
  sessionId: string;
};

export async function fetchMovieWatch(
  tmdbId: number,
): Promise<WatchDescriptor> {
  const res = await fetch(`/api/watch/movie/${tmdbId}`);
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
