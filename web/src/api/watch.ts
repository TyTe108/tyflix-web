// Client for the server's watch router (server/src/routes/watch.ts), mounted at
// /api/watch behind requireAuth. Everything WatchPage needs: play descriptors,
// the episode list, next-episode lookup, subtitle selection, progress
// reporting, and the Continue Watching rail.
//
// The thing to understand before reading any of this is what a play descriptor
// is. Video deliberately doesn't go through the Cloudflare Tunnel. The server
// mints a short-lived Plex transient token, resolves Plex's own plex.direct
// addresses, and hands back URLs pointing straight at the Plex server. So the
// browser really does hold a Plex credential here, and it has to, because the
// player authenticates to Plex itself. The long-lived token stays on the
// backend. Control plane through the tunnel, video direct.
//
// Errors follow the api/discover.ts convention with one improvement: the
// descriptor and episode fetchers read the server's `{ error }` body back out,
// so a user sees "not playable" or "re-login required" instead of a status
// code. The soft-fail calls at the bottom (timeline, next episode, continue
// watching) never throw at all, because none of them are worth interrupting
// playback over.
//
// Status codes worth knowing, from the server: 404 "not playable" usually means
// Seerr has no Plex ratingKey for the title, so it isn't on the server, though
// PUT /subtitle/:ratingKey reuses the same 404 for a different reason, when the
// Plex metadata carries no part id. 409 means the session predates Plex token
// capture and the user has to sign in again. Everything upstream (mint,
// connection resolve, metadata) collapses to 502.

// Plex's own addresses for this server. `local` is null when Plex advertises no
// LAN connection, and the player tries local first, then remote.
export type WatchConnections = {
  local: string | null;
  remote: string;
};

// HLS manifest URLs for the in-browser player. Both point at one shared
// transcode session, so falling from local to remote doesn't start a second one.
export type WatchHls = {
  local: string | null;
  remote: string;
};

// DASH URLs for the Chromecast receiver, which can't play Plex's HLS. These
// carry a different session id from the HLS pair on purpose, so Cast and the
// browser never fight over the same one.
export type WatchDash = {
  local: string | null;
  remote: string;
};

// An audio track on the file. `id` goes back as the audioStreamID tuning param
// to switch tracks, which is how commentary tracks get selected.
export type AudioStream = {
  id: string;
  language: string | null;
  codec: string | null;
  channels: number | null;
  title: string | null;
  default: boolean;
};

// A subtitle track. `id` goes to selectSubtitle. These get burned into the
// transcode rather than delivered as a sidecar, so switching one means
// restarting playback.
export type SubtitleStream = {
  id: string;
  language: string | null;
  codec: string | null;
  title: string | null;
  forced: boolean;
  external: boolean; // a separate file next to the video, not embedded
  textBased: boolean;
};

// Local to the watch flow: the backend only ever plays movies or episodes, and
// episodes carry no tmdbId (they're keyed on a raw Plex ratingKey).
export type WatchMediaType = "movie" | "episode";

// Everything the browser needs to start playing one item without asking again.
// All three descriptor endpoints return this shape; only /movie/:tmdbId fills
// in tmdbId, and /item/:ratingKey reports mediaType "movie" even though the
// caller never mentioned a movie.
export type WatchDescriptor = {
  mediaType: WatchMediaType;
  tmdbId?: number; // only present from fetchMovieWatch
  ratingKey: string;
  connections: WatchConnections;
  transient: string; // short-lived Plex token, deliberately sent in full
  hls: WatchHls;
  dash: WatchDash;
  dashDecision: WatchDash; // Plex wants /decision before start.mpd on cast
  sessionId: string; // the HLS transcode session, echoed back for control
  streams: { audio: AudioStream[]; subtitle: SubtitleStream[] };
  durationMs: number | null;
  creditsOffsetMs: number | null; // Plex's credits marker; fires the Up Next card
  partId: string | null; // the file part, needed for subtitle selection
  title: string | null;
  subheading: string | null; // show name and episode number, for episodes
  viewOffsetMs: number | null; // this user's resume position, null if unwatched
};

// Optional transcode tuning, sent as query params. Anything left undefined is
// omitted from the URL entirely, which keeps an untuned request identical to
// the server's baseline. The server validates all four and 400s on a bad value.
export type WatchTuning = {
  maxVideoBitrate?: number; // kbps
  videoResolution?: string; // "WxH", e.g. "1280x720"
  offset?: number; // seconds to start at
  audioStreamID?: string; // an id from streams.audio
};

/**
 * GET /api/watch/movie/:tmdbId. Play descriptor for a movie the browser only
 * knows by TMDB id, which is the case coming off a title page.
 *
 * This is the only descriptor route that pays for the Seerr hop, since a TMDB
 * id has to be turned into a Plex ratingKey before anything can play.
 *
 * @throws Error carrying the server's message. "not playable" (404) means Seerr
 * has no ratingKey, so the title isn't on the server; "re-login required" (409)
 * means the session has no Plex token.
 */
export async function fetchMovieWatch(
  tmdbId: number,
  tuning?: WatchTuning,
): Promise<WatchDescriptor> {
  return fetchWatch(`/api/watch/movie/${tmdbId}`, tuning);
}

/**
 * GET /api/watch/episode/:ratingKey. Play descriptor for one episode, keyed on
 * the raw Plex ratingKey the episode list already handed us.
 *
 * No availability check happens here. Plex enforces what the user's own token
 * is allowed to stream, and that's the gate.
 *
 * @throws Error carrying the server's message.
 */
export async function fetchEpisodeWatch(
  ratingKey: string,
  tuning?: WatchTuning,
): Promise<WatchDescriptor> {
  return fetchWatch(`/api/watch/episode/${ratingKey}`, tuning);
}

/**
 * GET /api/watch/item/:ratingKey. Play descriptor for any Plex item by raw
 * ratingKey.
 *
 * This exists for library movies with no TMDB id, which fetchMovieWatch simply
 * can't address. The response comes back with mediaType "movie" regardless.
 *
 * @throws Error carrying the server's message.
 */
export async function fetchItemWatch(
  ratingKey: string,
  tuning?: WatchTuning,
): Promise<WatchDescriptor> {
  return fetchWatch(`/api/watch/item/${ratingKey}`, tuning);
}

/**
 * PUT /api/watch/subtitle/:ratingKey.
 *
 * Selects (or clears with "0") the burned-in subtitle for the current user on
 * a media item. The caller must then restart the stream so Plex re-decides.
 *
 * The transcode URL parameter is not the selector, which took a while to pin
 * down. What actually works is this PUT against the file part followed by a
 * fresh descriptor and a restart, so the two calls always go together. The
 * server resolves the part id itself; the client only needs the ratingKey.
 *
 * @throws Error with the server's own message when it sent one.
 */
export async function selectSubtitle(
  ratingKey: string,
  subtitleStreamID: string,
): Promise<void> {
  const res = await fetch(`/api/watch/subtitle/${ratingKey}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subtitleStreamID }),
  });
  if (!res.ok) {
    const message = await readErrorMessage(res);
    throw new Error(message ?? `Failed to select subtitle (${res.status})`);
  }
}

export type TimelineState = "playing" | "paused" | "stopped";

// One progress report. The server is strict about these: a bad value would
// write garbage into somebody's real Plex watch state, so anything malformed
// comes back 400 rather than getting coerced.
export type TimelineBody = {
  ratingKey: string;
  state: TimelineState;
  time: number; // ms into the item
  duration: number; // ms total
};

/**
 * POST /api/watch/timeline. Reports playback position to Plex under the user's
 * own per-server token, which is what makes watch state per-user instead of
 * owner-wide. It's also why progress from Tyflix shows up on the TV.
 *
 * Fire-and-forget: failures are logged but must not interrupt playback. The
 * player calls this on a ticker, so it's the hot path for the whole resume
 * feature and it never rejects.
 */
export async function reportTimeline(body: TimelineBody): Promise<void> {
  try {
    const res = await fetch("/api/watch/timeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`Timeline report failed (${res.status})`);
    }
  } catch (err) {
    console.error("Timeline report failed", err);
  }
}

/**
 * The unload path for the same report. A normal fetch gets cancelled when the
 * tab closes, so sendBeacon is the only way the last position survives someone
 * hitting the X mid-episode.
 *
 * Best-effort. The payload is a Blob typed application/json so express.json()
 * still parses it on the other end.
 */
export function reportTimelineBeacon(body: TimelineBody): void {
  try {
    const blob = new Blob([JSON.stringify(body)], {
      type: "application/json",
    });
    navigator.sendBeacon("/api/watch/timeline", blob);
  } catch (err) {
    console.error("Timeline beacon failed", err);
  }
}

// A row in the episode browser. Flat, not nested by season, and keyed on
// ratingKey because that's what /watch/episode/:ratingKey takes.
export type Episode = {
  ratingKey: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
};

// What auto-advances after the current episode. `thumb` is a Plex image path,
// not a URL, and the Up Next card composes the full address from the descriptor
// it already holds.
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

/**
 * GET /api/watch/tv/:tmdbId/episodes. The flat episode list for a show.
 *
 * These rows carry no per-user watch state. The server lists with the server
 * token rather than the caller's, so don't read anything into a missing
 * viewOffset here.
 *
 * Defensive on the way out: a missing showRatingKey becomes "" and a missing
 * episodes array becomes [], so a half-formed response degrades to an empty
 * list instead of throwing inside a render.
 *
 * @throws Error with the server's message, typically "not playable" when Seerr
 * has no show-level ratingKey.
 */
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

/**
 * GET /api/watch/episode/:ratingKey/next. What plays after this one, or null at
 * the end of a series.
 *
 * Called while the current episode is still going so the Up Next card is ready
 * before the credits marker hits.
 *
 * Soft-fail: a missing/failed/malformed next episode must never break playback.
 * Never throws; null covers all of those cases plus "there is no next one".
 */
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

// A card on the Continue Watching rail, straight out of Plex's on-deck list for
// this user. viewOffset and duration are both milliseconds and drive the
// progress bar under the thumbnail.
export type ContinueItem = {
  ratingKey: string;
  type: "movie" | "episode";
  title: string;
  subtitle: string | null;
  thumb: string | null;
  viewOffset: number | null;
  duration: number | null;
};

/**
 * GET /api/watch/continue. Plex's on-deck list for the signed-in user, which is
 * the Continue Watching rail at the top of the Library page.
 *
 * Soft-fail: a failed continue list must never break the library landing. An
 * empty array means either nothing to resume or something went wrong, and the
 * rail treats those the same way by not rendering. The server also returns an
 * empty list for a session with no stored Plex token.
 */
export async function fetchContinueWatching(): Promise<ContinueItem[]> {
  try {
    const res = await fetch("/api/watch/continue");
    if (!res.ok) {
      console.error(`Continue watching fetch failed (${res.status})`);
      return [];
    }
    const body = (await res.json()) as { items?: unknown };
    if (!Array.isArray(body.items)) {
      return [];
    }
    return body.items as ContinueItem[];
  } catch (err) {
    console.error("Continue watching fetch failed", err);
    return [];
  }
}

// Field-by-field validation of the next-episode payload. Anything short of a
// complete row returns null, since a half-built Up Next card is worse than none.
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

// The one place a descriptor is actually fetched; the three exported wrappers
// are just different paths into here. Undefined tuning keys are left out of the
// query string rather than serialized as "undefined".
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

// Digs the server's `{ error }` string out of a failure body. Null when the
// body isn't JSON or has no error field, and the caller falls back to the
// status code.
async function readErrorMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}
