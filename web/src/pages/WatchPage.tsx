// The player page. Everything that happens after someone presses Play.
//
// Three routes in App.tsx render this same component, and whichever param is
// present decides where the play descriptor comes from:
//
//   /watch/movie/:tmdbId        from a title page, TMDB id joined to a Plex
//                               ratingKey by Seerr on the server
//   /watch/episode/:ratingKey   an episode, already keyed on Plex's own id
//   /watch/item/:itemRatingKey  anything in the Library, including the movies
//                               that carry no TMDB id at all
//
// The play sequence: ask the backend for a descriptor (GET /api/watch/...), get
// back a short-lived Plex transient token plus Plex's own plex.direct
// addresses, then hand those URLs to hls.js. Video does not go through the
// Cloudflare Tunnel. The browser streams straight from Plex, which is why the
// transient token is in the query string of every media URL on this page.
// Control plane through the tunnel, video direct.
//
// The rest of the screen hangs off that one descriptor. viewOffsetMs (read
// under this user's own Plex token, so it's their position and not the owner's)
// opens the resume dialog, creditsOffsetMs fires Up Next, and on an episode
// Previous and Next links sit under the player. streams.audio and
// streams.subtitle fill the settings menu, and POST /api/watch/timeline reports
// progress back so Plex and the TV in the other room agree on where you stopped.
//
// Casting is a second playback target rather than a second page. Once a Cast
// session connects, local hls.js is torn down and the receiver plays Plex's
// DASH instead, with a separate reporter driving the timeline off the receiver
// clock. Disconnecting hands the position back to the local <video>.

import Hls from "hls.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import {
  fetchEpisodeWatch,
  fetchItemWatch,
  fetchMovieWatch,
  fetchNextEpisode,
  fetchPreviousEpisode,
  reportTimeline,
  reportTimelineBeacon,
  audioIdToSelect,
  selectAudio,
  selectSubtitle,
  type NextEpisode,
  type PreviousEpisode,
  type SubtitleStream,
  type TimelineState,
  type WatchConnections,
  type WatchDescriptor,
  type WatchTuning,
} from "../api/watch";
import { BackControl } from "../components/BackControl";
import { BackIcon } from "../components/BackIcon";
import { CastStatusOverlay } from "../components/CastStatusOverlay";
import { EpisodeNav } from "../components/EpisodeNav";
import {
  PlayerControls,
  type QualityId,
  type StreamSettings,
} from "../components/PlayerControls";
import { ReconnectingOverlay } from "../components/ReconnectingOverlay";
import { ResumeDialog, formatResumeTime } from "../components/ResumeDialog";
import { UpNextCard } from "../components/UpNextCard";
import { loadMediaOnCast } from "../cast/loadMediaOnCast";
import { subscribeSessionReady } from "../cast/subscribeSessionReady";
import { useCastPlayer } from "../cast/useCastPlayer";
import { useCastState } from "../cast/useCastState";
import { useAuth } from "../auth/AuthContext";
import { isLandingLocation, landingState } from "../lib/landing";
import {
  classifyFatalError,
  createRecoveryBudget,
  isStaleSessionError,
  planRestart,
  recordAttemptFailed,
  recordAttemptRecovered,
  recordRestartStart,
  type RecoveryBudget,
  type RestartPlan,
} from "../lib/playbackRecovery";
import {
  KEEPALIVE_INTERVAL_MS,
  buildPingUrl,
  pingTranscodeSession,
} from "../lib/transcodeKeepalive";

// Auto-advance is a per-browser preference, so it lives in localStorage.
const AUTO_PLAY_STORAGE_KEY = "tyflix.autoPlay";
// Last-chosen subtitle language (+ forced), re-resolved per item by language
// rather than by Plex stream id (ids are part-scoped and change every episode).
const SUBTITLE_PREFERENCE_STORAGE_KEY = "tyflix.subtitlePreference";
// Floor for the Up Next card. Plenty of episodes have no credits marker, and
// this is what covers them.
const UP_NEXT_WINDOW_SEC = 30;
// How often a playing stream reports its position to Plex.
const TIMELINE_HEARTBEAT_MS = 10_000;
// Scrubbing emits a burst of "seeked" events; at most one report per second.
const TIMELINE_SEEK_THROTTLE_MS = 1000;

// Page-level load state. A quality or audio switch deliberately never returns
// to "loading". See onStreamSettingsChange for why that matters.
type LoadStatus = "loading" | "ready" | "error";

// A seek waiting for the media element to be ready for it. Three things set
// this: the resume dialog, an in-place transcode restart, and the handoff back
// from a Cast session.
type PendingResume = {
  // Seconds into the item.
  position: number;
  // Whether to resume playing once the seek lands, or hold it paused.
  wasPlaying: boolean;
};

// One recovery from a fatal hls.js error on a stream that was working. It lives
// from the fatal error until the restarted stream buffers a fragment, and it
// survives failed attempts, so the banner and the place to return to stay the
// same across them.
type ActiveRecovery = {
  // Seconds into the item to return to, and whether the viewer was playing.
  // Every attempt parks these in pendingResumeRef. Both start from a seek that
  // was already parked when the recovery began, if there was one, and from the
  // element otherwise. A parked seek wins because the HLS effect pauses the
  // element while a seek waits, so the element reads paused and near 0 although
  // the viewer was playing at the parked place. A settings switch and the Cast
  // handoff park seeks this way. The place is only a stored value here:
  // resolveRecoveryPosition says which one to use, because the old stream keeps
  // playing its buffer until an attempt attaches.
  position: number;
  wasPlaying: boolean;
  // True once an attempt of this recovery has been attached with setDescriptor.
  // Its teardown reset the element, so from then on the stored place is the
  // only record of where the viewer was.
  attached: boolean;
  // waiting: a timer runs before the next descriptor fetch.
  // fetching: a descriptor fetch is in flight.
  // attaching: a new descriptor was set and its stream is loading.
  phase: "waiting" | "fetching" | "attaching";
  timerId: ReturnType<typeof setTimeout> | null;
  // Fatal errors seen during this recovery, for the log when it gives up.
  failures: HlsAttemptFailure[];
  hadLocalUrl: boolean;
  // The most recent attach that failed: the item's original stream until an
  // attempt attaches, then that attempt. The give-up text shows its report.
  lastAttach: { attempts: HlsAttemptFailure[]; hadLocalUrl: boolean };
  // The error message of a descriptor fetch that was the last attempt to fail,
  // or null when the last attempt failed on a stream.
  fetchError: string | null;
};

// What the HLS effect hands to the recovery logic when a fatal error calls for
// a restart.
type FatalRecoveryInput = {
  // The fatal error that ended the attach.
  failure: HlsAttemptFailure;
  // A copy of every fatal error of that attach, local and then remote.
  attemptFailures: HlsAttemptFailure[];
  hadLocalUrl: boolean;
};

// Mirror of the <video> clock in seconds, so rendering can react to time.
// Fed by timeupdate / durationchange / loadedmetadata.
type PlaybackClock = {
  currentTime: number;
  duration: number;
};

// What the resume dialog needs: where Plex says this user stopped, plus the
// runtime when we know it (null just drops the "x minutes left" line).
type ResumeDialogState = {
  positionSeconds: number;
  durationSeconds: number | null;
};

// Offer to resume when Plex has a real position for this user that isn't
// effectively the end of the item. Past 95% counts as finished, so a title you
// watched to the credits opens clean instead of asking.
function shouldOfferResumeDialog(descriptor: WatchDescriptor): boolean {
  const { viewOffsetMs, durationMs } = descriptor;
  return (
    viewOffsetMs !== null &&
    viewOffsetMs > 0 &&
    (durationMs === null || viewOffsetMs < 0.95 * durationMs)
  );
}

// Descriptor milliseconds into dialog seconds. A missing or zero duration
// becomes null rather than 0, so the dialog can tell "unknown" from "no time
// left".
function resumeDialogFromDescriptor(
  descriptor: WatchDescriptor,
): ResumeDialogState {
  return {
    positionSeconds: (descriptor.viewOffsetMs ?? 0) / 1000,
    durationSeconds:
      descriptor.durationMs !== null && descriptor.durationMs > 0
        ? descriptor.durationMs / 1000
        : null,
  };
}

// One fatal hls.js failure on one connection attempt. `sourceUrl` is the full
// stream URL used for that attach; it is redacted before any text or log leaves
// buildHlsPlaybackFailureReport.
export type HlsAttemptFailure = {
  connection: "local" | "remote";
  sourceUrl: string;
  // Loose on purpose: an unexpected hls.js shape is itself a finding, so we
  // accept whatever landed and print what we got rather than requiring fields.
  data: Record<string, unknown>;
};

export type HlsPlaybackFailureReport = {
  message: string;
  logPayload: {
    hadLocalUrl: boolean;
    attempts: Array<Record<string, unknown>>;
  };
};

/**
 * Hostname + pathname only. Stream URLs carry X-Plex-Token (and a session id)
 * as query parameters; this text gets screenshotted and sent over chat, so a
 * full URL must never appear on screen or in console.error.
 */
export function redactStreamUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    // Not parseable as absolute — still strip query/hash so a token cannot
    // leak through a relative or mangled string.
    const noHash = url.split("#")[0] ?? url;
    return noHash.split("?")[0] ?? noHash;
  }
}

function redactIfUrlLike(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (/^https?:\/\//i.test(value) || /X-Plex-Token/i.test(value)) {
    return redactStreamUrl(value);
  }
  return value;
}

// Pull the fields we care about off an hls.js error, redacting any URL that
// might carry a Plex token. Missing expected fields are not filled in with
// generics — whatever arrived is what gets reported.
function summarizeHlsErrorData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  if ("type" in data) {
    summary.type = data.type;
  }
  if ("details" in data) {
    summary.details = data.details;
  }

  const response = data.response;
  if (response !== undefined && response !== null && typeof response === "object") {
    const raw = response as Record<string, unknown>;
    const resp: Record<string, unknown> = {};
    if ("code" in raw) {
      resp.code = raw.code;
    }
    if ("text" in raw) {
      resp.text = raw.text;
    }
    if (typeof raw.url === "string") {
      resp.url = redactStreamUrl(raw.url);
    }
    for (const [key, value] of Object.entries(raw)) {
      if (key === "code" || key === "text" || key === "url" || key === "data") {
        continue;
      }
      resp[key] = redactIfUrlLike(value);
    }
    summary.response = resp;
  }

  if (typeof data.url === "string") {
    summary.url = redactStreamUrl(data.url);
  }
  if ("reason" in data) {
    summary.reason = data.reason;
  }
  const err = data.error;
  if (err instanceof Error) {
    summary.error = err.message;
  } else if (err !== undefined && err !== null && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") {
      summary.error = redactIfUrlLike(message);
    }
  }

  // Unexpected shape: no type/details/response at all — dump remaining keys so
  // the device still shows what hls.js handed us.
  if (
    summary.type === undefined &&
    summary.details === undefined &&
    summary.response === undefined
  ) {
    for (const [key, value] of Object.entries(data)) {
      if (key === "fatal" || key in summary) {
        continue;
      }
      if (
        key === "frag" ||
        key === "loader" ||
        key === "networkDetails" ||
        key === "context" ||
        key === "error" ||
        key === "err"
      ) {
        summary[key] = value === null ? null : typeof value;
        continue;
      }
      summary[key] = redactIfUrlLike(value);
    }
  }

  return summary;
}

// One line about a fatal error for the recovery warnings: type, details, the
// HTTP code when there is one, and the stream URL as host and path only. The
// URL of the failing fragment is left out because its path holds the session id.
function describeFatalForLog(failure: HlsAttemptFailure): string {
  const { type, details, response } = failure.data;
  const code =
    typeof response === "object" && response !== null && "code" in response
      ? ` HTTP ${String(response.code)}`
      : "";
  return `${String(type)} ${String(details)}${code} on ${redactStreamUrl(failure.sourceUrl)}`;
}

/**
 * Build the on-screen diagnostic string and the structured console.error
 * payload for a complete local→remote (or remote-only) failure.
 */
export function buildHlsPlaybackFailureReport(input: {
  hadLocalUrl: boolean;
  attempts: HlsAttemptFailure[];
}): HlsPlaybackFailureReport {
  const attempts: Array<Record<string, unknown>> = input.attempts.map(
    (attempt) => ({
      connection: attempt.connection,
      url: redactStreamUrl(attempt.sourceUrl),
      ...summarizeHlsErrorData(attempt.data),
    }),
  );

  const logPayload = {
    hadLocalUrl: input.hadLocalUrl,
    attempts,
  };

  const lines: string[] = [
    "Playback failed on all connections.",
    `Descriptor had local URL: ${input.hadLocalUrl ? "yes" : "no"}`,
    "",
  ];

  for (let i = 0; i < attempts.length; i++) {
    const summarized = attempts[i]!;
    lines.push(`${i + 1}. ${String(summarized.connection)} — ${String(summarized.url)}`);

    if (summarized.type !== undefined) {
      lines.push(`   type: ${String(summarized.type)}`);
    }
    if (summarized.details !== undefined) {
      lines.push(`   details: ${String(summarized.details)}`);
    }

    const resp = summarized.response;
    if (resp !== undefined && resp !== null && typeof resp === "object") {
      const r = resp as Record<string, unknown>;
      if (r.code !== undefined || r.text !== undefined) {
        const code = r.code !== undefined ? String(r.code) : "?";
        const text =
          r.text !== undefined && String(r.text) !== ""
            ? ` ${String(r.text)}`
            : "";
        lines.push(`   HTTP: ${code}${text}`);
      }
    }

    // Fail-loud: when the usual fields are missing, print the summarized object
    // so an unexpected hls.js shape is still visible on the device.
    if (
      summarized.type === undefined &&
      summarized.details === undefined &&
      summarized.response === undefined
    ) {
      lines.push(`   raw: ${JSON.stringify(summarized)}`);
    } else if (
      summarized.type === undefined ||
      summarized.details === undefined
    ) {
      const extras: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(summarized)) {
        if (
          key === "connection" ||
          key === "url" ||
          key === "type" ||
          key === "details" ||
          key === "response"
        ) {
          continue;
        }
        extras[key] = value;
      }
      if (Object.keys(extras).length > 0) {
        lines.push(`   also: ${JSON.stringify(extras)}`);
      }
    }

    lines.push("");
  }

  return {
    message: lines.join("\n").trimEnd(),
    logPayload,
  };
}

// Auto-advance defaults to on, including when localStorage can't be read.
function readStoredAutoPlay(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_PLAY_STORAGE_KEY);
    if (raw === null) {
      return true;
    }
    return raw === "true";
  } catch {
    return true;
  }
}

// Best effort. A failed write costs the preference on the next load, nothing
// more, so it isn't surfaced to the user.
function writeStoredAutoPlay(value: boolean): void {
  try {
    localStorage.setItem(AUTO_PLAY_STORAGE_KEY, String(value));
  } catch {
    // private mode / quota — preference stays in-memory only
  }
}

// Language (+ forced) remembered across item loads. null means Off / never set.
type SubtitlePreference = {
  language: string;
  forced: boolean;
};

// Corrupt or unreadable data is treated as no preference, same as a missing key.
function readStoredSubtitlePreference(): SubtitlePreference | null {
  try {
    const raw = localStorage.getItem(SUBTITLE_PREFERENCE_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { language?: unknown }).language !== "string" ||
      typeof (parsed as { forced?: unknown }).forced !== "boolean"
    ) {
      return null;
    }
    return {
      language: (parsed as { language: string }).language,
      forced: (parsed as { forced: boolean }).forced,
    };
  } catch {
    return null;
  }
}

// Best effort. null clears the key (explicit Off, or wipe a prior choice).
function writeStoredSubtitlePreference(pref: SubtitlePreference | null): void {
  try {
    if (pref === null) {
      localStorage.removeItem(SUBTITLE_PREFERENCE_STORAGE_KEY);
      return;
    }
    localStorage.setItem(SUBTITLE_PREFERENCE_STORAGE_KEY, JSON.stringify(pref));
  } catch {
    // private mode / quota — preference stays in-memory only
  }
}

/**
 * Picks a subtitle track for a remembered language preference.
 *
 * Case-insensitive language match. Prefers a track whose forced flag matches
 * the preference; otherwise the first same-language track. Returns null when
 * nothing in `tracks` shares the language — never substitutes another one.
 */
function resolveSubtitleForPreference(
  tracks: SubtitleStream[],
  pref: SubtitlePreference,
): SubtitleStream | null {
  const wanted = pref.language.toLowerCase();
  const sameLanguage = tracks.filter(
    (track) =>
      typeof track.language === "string" &&
      track.language.toLowerCase() === wanted,
  );
  if (sameLanguage.length === 0) {
    return null;
  }
  return (
    sameLanguage.find((track) => track.forced === pref.forced) ??
    sameLanguage[0] ??
    null
  );
}

/**
 * True only when Play navigation latched `{ enterFullscreen: true }` onto
 * location.state. Anything else (missing state, wrong shape, non-boolean) is
 * false so deep links and the ended auto-advance stay non-fullscreen.
 */
export function wantsFullscreenFromNavState(state: unknown): boolean {
  if (state === null || typeof state !== "object") {
    return false;
  }
  return (
    "enterFullscreen" in state &&
    (state as { enterFullscreen: unknown }).enterFullscreen === true
  );
}

/**
 * Whether PlayerControls should enter fullscreen on mount.
 *
 * Nav state means the user pressed Play; the account preference decides
 * whether that Play also means fullscreen. Both must be true.
 */
export function shouldEnterFullscreenOnMount(
  navState: unknown,
  fullscreenOnPlay: boolean,
): boolean {
  return wantsFullscreenFromNavState(navState) && fullscreenOnPlay;
}

/**
 * Router state for one switch from episode to episode inside the player.
 *
 * The switch replaces the current history entry, so Back from the player
 * returns to the page before it. When the current entry opened the visit,
 * the landing marker rides along, because a replace mints a fresh key, as
 * lib/landing.ts explains. A Play click's fullscreen request does not carry
 * over.
 */
export function episodeSwitchState(
  current: { key: string; state: unknown },
  enterFullscreen: boolean,
):
  | { landing: true }
  | { enterFullscreen: true }
  | { landing: true; enterFullscreen: true }
  | null {
  const landing = isLandingLocation(current);
  if (!landing && !enterFullscreen) {
    return null;
  }
  if (landing && enterFullscreen) {
    return { landing: true, enterFullscreen: true };
  }
  if (landing) {
    return landingState;
  }
  return { enterFullscreen: true };
}

// Route params are whatever's in the URL bar. Anything that isn't a positive
// integer comes back null and the page renders its error state instead of
// firing a doomed request.
function parseTmdbId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// The Quality menu's presets, expressed as transcode tuning for the backend.
// Bitrates are kbps. "original" sends nothing at all, which leaves Plex on the
// fixed baseline the server builds.
function tuningForQuality(quality: QualityId): WatchTuning {
  switch (quality) {
    case "original":
      return {};
    case "1080p":
      return { maxVideoBitrate: 12000, videoResolution: "1920x1080" };
    case "720p":
      return { maxVideoBitrate: 4000, videoResolution: "1280x720" };
    case "480p":
      return { maxVideoBitrate: 1500, videoResolution: "854x480" };
  }
}

// Folds the quality preset and the chosen audio track into one tuning object.
// Undefined when there's nothing to say, which keeps the descriptor request
// byte-identical to the untuned one.
//
// Subtitles are absent here on purpose: they're a part-level PUT, not a URL
// param. Audio is a part-level PUT too, and the audioStreamID URL param did
// nothing in the HLS test on this Plex (DASH wasn't checked). The param is
// still sent. onStreamSettingsChange handles both PUTs.
function buildWatchTuning(settings: StreamSettings): WatchTuning | undefined {
  const tuning: WatchTuning = {
    ...tuningForQuality(settings.quality),
    ...(settings.audioStreamId
      ? { audioStreamID: settings.audioStreamId }
      : {}),
  };
  return Object.keys(tuning).length > 0 ? tuning : undefined;
}

// Up Next thumbnail, composed in the browser against Plex's photo transcoder.
// Local address first and remote second; UpNextCard walks the list on an image
// error, which is the same local-then-remote fallback the player itself does.
// The transient token rides in the query string because this request goes
// straight to Plex, not through our API.
function buildThumbUrls(
  thumb: string | null,
  connections: WatchConnections,
  token: string,
): string[] {
  if (thumb === null) {
    return [];
  }
  const bases: string[] = [];
  if (connections.local !== null) {
    bases.push(connections.local);
  }
  bases.push(connections.remote);

  return bases.map((conn) => {
    const base = conn.endsWith("/") ? conn.slice(0, -1) : conn;
    return `${base}/photo/:/transcode?url=${encodeURIComponent(thumb)}&width=320&height=180&X-Plex-Token=${token}`;
  });
}

// Duration for a timeline report. Prefer whatever the player (or the Cast
// receiver) says, fall back to the descriptor's, and return 0 when neither is
// usable so the caller can skip the report entirely.
function resolveTimelineDurationMs(
  primarySeconds: number,
  fallbackMs: number | null | undefined,
): number {
  const fromPrimary = Math.round(primarySeconds * 1000);
  if (Number.isFinite(fromPrimary) && fromPrimary > 0) {
    return fromPrimary;
  }
  if (
    typeof fallbackMs === "number" &&
    Number.isFinite(fallbackMs) &&
    fallbackMs > 0
  ) {
    return Math.round(fallbackMs);
  }
  return 0;
}

// Body of POST /api/watch/timeline. Both times are milliseconds.
type TimelinePayload = {
  ratingKey: string;
  state: TimelineState;
  time: number;
  duration: number;
};

// Null when there's no usable duration. The server validates duration > 0 and
// answers 400 otherwise, so a report without one is wasted anyway.
function buildTimelinePayload(
  ratingKey: string,
  state: TimelineState,
  timeMs: number,
  durationMs: number,
): TimelinePayload | null {
  if (durationMs <= 0) {
    return null;
  }
  return {
    ratingKey,
    state,
    time: Math.max(0, timeMs),
    duration: durationMs,
  };
}

// sendBeacon on the unload paths (pagehide, tab going hidden), plain fetch
// otherwise. Both are fire-and-forget in api/watch.ts, so nothing here waits.
function sendTimelinePayload(
  payload: TimelinePayload | null,
  useBeacon: boolean,
): void {
  if (payload === null) {
    return;
  }
  if (useBeacon) {
    reportTimelineBeacon(payload);
  } else {
    void reportTimeline(payload);
  }
}

/**
 * The watch page: player, control bar, resume dialog, Up Next card and Cast
 * status, shared by all three /watch routes.
 *
 * Holds exactly one descriptor at a time. Re-fetching that descriptor is how
 * the page changes quality, audio track or subtitles, and the `<video>` element
 * survives the swap on purpose.
 */
export function WatchPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { preferences } = useAuth();
  // Nav state means Play was pressed; the preference decides whether that
  // means fullscreen. Deep links and ended auto-advance pass no nav state.
  const enterFullscreenOnMount = shouldEnterFullscreenOnMount(
    location.state,
    preferences.fullscreenOnPlay,
  );
  const {
    tmdbId: rawTmdbId,
    ratingKey: rawRatingKey,
    itemRatingKey: rawItemRatingKey,
  } = useParams<{
    tmdbId: string;
    ratingKey: string;
    itemRatingKey: string;
  }>();
  // The /watch/episode/:ratingKey route always supplies ratingKey; the
  // /watch/item/:itemRatingKey route supplies itemRatingKey; the
  // /watch/movie/:tmdbId route supplies tmdbId. Pick the source accordingly.
  const isEpisode = rawRatingKey !== undefined;
  const ratingKey =
    isEpisode && /^\d+$/.test(rawRatingKey) ? rawRatingKey : null;
  const isItem = !isEpisode && rawItemRatingKey !== undefined;
  const itemRatingKey =
    isItem && /^\d+$/.test(rawItemRatingKey) ? rawItemRatingKey : null;
  const tmdbId = parseTmdbId(rawTmdbId);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // A seek waiting for the element to be ready to take it.
  const pendingResumeRef = useRef<PendingResume | null>(null);
  // Last good Cast receiver position; survives disconnect so local HLS can resume.
  const lastRemotePositionRef = useRef<number | null>(null);
  // Last real position of the local <video>, in seconds. The local timeline
  // reporter writes it whenever the element reads above 0 (timeupdate, playing,
  // pause, seeked), and the Cast handoff sets it to the receiver's last
  // position when it parks that position for the local stream. The reporter
  // falls back to it when the element reads 0 after hls.js tears the stream
  // down. The load effect resets it to null for each item. A position of 0
  // never counts as real, so null means nothing real has been seen yet.
  const lastGoodPositionRef = useRef<number | null>(null);
  // Previous value of castUi.connected, so the true-to-false edge is detectable.
  const wasCastConnectedRef = useRef(false);
  // Last subtitleStreamId successfully applied via PUT. Avoids redundant
  // selects when only quality/audio change. Starts null each item load, then
  // may be set from the stored language preference before status goes ready
  // (or by an in-episode switch). Not a mirror of whatever Plex had selected
  // on its own.
  const appliedSubtitleIdRef = useRef<string | null>(null);
  // The tuning of the last Quality or audio change, so a restart asks for the
  // same transcode. The page needs it because Quality lives in PlayerControls,
  // and the page only sees it as the settings that onStreamSettingsChange
  // receives. Undefined means no change was made, which fetches an untuned
  // descriptor. The load effect resets it for each item.
  const currentTuningRef = useRef<WatchTuning | undefined>(undefined);
  // True once any stream of this item buffered a fragment. Before that a fatal
  // error means the item never worked and goes to the error state. The load
  // effect resets it for each item.
  const streamEstablishedRef = useRef(false);
  // The last time this item showed its session was alive, as Date.now()
  // milliseconds. A loaded fragment (FRAG_LOADED), a parsed manifest
  // (MANIFEST_PARSED), and a keepalive ping that comes back alive count. The
  // load effect resets it to null for each item, and null means this item has
  // shown no sign of life yet.
  const lastSignOfLifeRef = useRef<number | null>(null);
  // Restart starts and failed attempts for this item, see playbackRecovery.ts.
  const recoveryBudgetRef = useRef<RecoveryBudget>(createRecoveryBudget());
  // The recovery in progress, or null. At most one runs at a time.
  const recoveryRef = useRef<ActiveRecovery | null>(null);
  // Settings switches whose descriptor fetch is still out. A fatal error on
  // the old stream during one is left to the switch, which replaces the stream.
  const settingsSwitchesInFlightRef = useRef(0);
  // Destroys the hls.js instance the HLS effect currently owns. A recovery that
  // gives up uses it, because the error state does not re-run that effect.
  const destroyHlsRef = useRef<(() => void) | null>(null);
  // The latest recovery handlers, for the HLS effect. That effect runs once per
  // descriptor, so it reads them through this ref instead of closing over one
  // render's copies.
  const recoveryHandlersRef = useRef<{
    onFatalError: (input: FatalRecoveryInput) => void;
    onStreamBuffered: () => void;
  } | null>(null);
  // The "Reconnecting…" banner, from the fatal error until the restarted stream
  // plays.
  const [reconnecting, setReconnecting] = useState(false);
  const [descriptor, setDescriptor] = useState<WatchDescriptor | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [autoPlay, setAutoPlay] = useState(readStoredAutoPlay);
  const [nextEpisode, setNextEpisode] = useState<NextEpisode | null>(null);
  const [previousEpisode, setPreviousEpisode] =
    useState<PreviousEpisode | null>(null);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [playbackClock, setPlaybackClock] = useState<PlaybackClock>({
    currentTime: 0,
    duration: 0,
  });
  const [resumeDialog, setResumeDialog] = useState<ResumeDialogState | null>(
    null,
  );
  // castUi is the session (available / connected / toggle); castRemote is the
  // receiver's playback state and commands. They come from separate Cast SDK
  // objects and don't flip at the same moment, which several effects below care
  // about.
  const castUi = useCastState();
  const castRemote = useCastPlayer();
  const castRemoteRef = useRef(castRemote);
  castRemoteRef.current = castRemote;
  const castReportingRef = useRef(false);
  // Inert local reporter whenever a cast session is connected — HLS tears the
  // <video> down on connected, which can precede RemotePlayer.isActive.
  castReportingRef.current = castUi.connected || castRemote.isActive;
  // Filled in by the cast reporter effect. Lets the RemotePlayer subscription
  // push play/pause into that reporter without tearing it down and rebuilding
  // it every time the receiver changes state.
  const castTimelineBridgeRef = useRef<{
    onPlayingChange: (playing: boolean) => void;
  } | null>(null);
  // Everything from here down mirrors state into a ref. The media listeners are
  // bound once per descriptor and would otherwise close over stale values, and
  // rebinding them on every timeupdate is not an option.
  const autoPlayRef = useRef(autoPlay);
  const nextEpisodeRef = useRef(nextEpisode);
  const upNextDismissedRef = useRef(upNextDismissed);
  const timelineDurationMsRef = useRef<number | null>(null);
  const resumeDialogOpenRef = useRef(false);
  // Starts the instance that is waiting behind the Resume dialog, once its
  // manifest has parsed. Null when no instance is waiting.
  const startHeldLoadRef = useRef<((position: number) => void) | null>(null);
  autoPlayRef.current = autoPlay;
  nextEpisodeRef.current = nextEpisode;
  upNextDismissedRef.current = upNextDismissed;
  timelineDurationMsRef.current = descriptor?.durationMs ?? null;
  resumeDialogOpenRef.current = resumeDialog !== null;

  // Start playback at a position. When an instance is waiting on the Resume
  // dialog, start that instance at the position, or park the choice until its
  // manifest parses. Otherwise seek and play straight away when the element
  // already has metadata, and park the seek until the manifest parses when it
  // does not.
  const beginPlaybackAt = useCallback((position: number) => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const startHeld = startHeldLoadRef.current;
    if (startHeld !== null) {
      startHeld(position);
      return;
    }

    const start = () => {
      try {
        video.currentTime = position;
      } catch (err: unknown) {
        console.error("Resume seek failed", err);
      }
      void video.play().catch((err: unknown) => {
        console.error("Resume play failed", err);
      });
    };

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      start();
      return;
    }

    pendingResumeRef.current = { position, wasPlaying: true };
  }, []);

  // "Resume" in the dialog, and also its close/Escape path: dismissing without
  // choosing picks up where Plex said you stopped rather than starting over.
  const handleResumeFromSaved = useCallback(() => {
    if (resumeDialog === null) {
      return;
    }
    const position = resumeDialog.positionSeconds;
    setResumeDialog(null);
    beginPlaybackAt(position);
  }, [resumeDialog, beginPlaybackAt]);

  // "Start over". No new descriptor: the stream was built with no offset, so it
  // already begins at zero and this is only a seek.
  const handleStartOver = useCallback(() => {
    setResumeDialog(null);
    beginPlaybackAt(0);
  }, [beginPlaybackAt]);

  // Ends the recovery in progress, if any: stops its timer, hides the banner,
  // and makes a descriptor fetch that is still out harmless, because the fetch
  // only acts while its recovery is the one in recoveryRef.
  const cancelRecovery = useCallback(() => {
    const recovery = recoveryRef.current;
    if (recovery !== null && recovery.timerId !== null) {
      clearTimeout(recovery.timerId);
    }
    recoveryRef.current = null;
    setReconnecting(false);
  }, []);

  // Fetches a descriptor from the endpoint this page loaded from, with the
  // given tuning. Used by a settings switch and by a restart. It does not await
  // anything before the fetch call, so a switch still fetches on the click.
  // Throws for a route param that did not validate.
  const fetchDescriptorForRoute = (
    tuning: WatchTuning | undefined,
  ): Promise<WatchDescriptor> => {
    if (isEpisode) {
      if (ratingKey === null) {
        throw new Error("Invalid episode");
      }
      return fetchEpisodeWatch(ratingKey, tuning);
    }
    if (isItem) {
      if (itemRatingKey === null) {
        throw new Error("Invalid title");
      }
      return fetchItemWatch(itemRatingKey, tuning);
    }
    if (tmdbId === null) {
      throw new Error("Invalid title");
    }
    return fetchMovieWatch(tmdbId, tuning);
  };

  // The place a recovery returns to. Until an attempt has attached, the old
  // stream is still on the element and plays what it buffered, so the element's
  // current time is the place when it is above 0. It is read at the moment it
  // is used. After an attempt attached, the teardown reset the element, and the
  // place is the stored one.
  const resolveRecoveryPosition = (recovery: ActiveRecovery): number => {
    if (!recovery.attached) {
      const video = videoRef.current;
      const live = video === null ? 0 : video.currentTime;
      if (Number.isFinite(live) && live > 0) {
        return live;
      }
    }
    return recovery.position;
  };

  // The restart budget is spent. Destroys the stream, logs the report that
  // every failed connection feeds, and shows where the item stood followed by
  // the connection report of the most recent attach that failed, so the page
  // never ends as a dead player without a message. A last attempt that failed
  // at the descriptor fetch adds one line with that error.
  const giveUpRecovery = (
    recovery: ActiveRecovery,
    plan: Extract<RestartPlan, { kind: "give-up" }>,
  ) => {
    const position = resolveRecoveryPosition(recovery);
    recoveryRef.current = null;
    setReconnecting(false);
    destroyHlsRef.current?.();
    pendingResumeRef.current = null;
    const logReport = buildHlsPlaybackFailureReport({
      hadLocalUrl: recovery.hadLocalUrl,
      attempts: recovery.failures,
    });
    console.error("HLS playback failed", logReport.logPayload);
    const attachReport = buildHlsPlaybackFailureReport({
      hadLocalUrl: recovery.lastAttach.hadLocalUrl,
      attempts: recovery.lastAttach.attempts,
    });
    const fetchLine =
      recovery.fetchError === null
        ? ""
        : `\nThe request for a new stream failed: ${recovery.fetchError}.`;
    setStatus("error");
    setError(
      `Playback stopped. The stream was restarted ${plan.restartsInWindow} times in the last 5 minutes and kept failing. It was at ${formatResumeTime(position)}. Reload the page to continue.\n\n${attachReport.message}${fetchLine}`,
    );
  };

  // Plans the next restart of a recovery and either starts it now, waits for
  // its delay, or gives up. Logs one warning per restart with the attempt
  // number, the delay and what went wrong, with URLs as host and path only.
  const scheduleRestart = (recovery: ActiveRecovery, reason: string) => {
    const budget = recoveryBudgetRef.current;
    const plan = planRestart(budget, Date.now());
    if (plan.kind === "give-up") {
      giveUpRecovery(recovery, plan);
      return;
    }
    console.warn(
      `Playback recovery: attempt ${budget.failedStreak + 1}, restarting in ${plan.delayMs} ms after ${reason}`,
    );
    recovery.phase = "waiting";
    if (plan.delayMs <= 0) {
      startRestart(recovery);
      return;
    }
    recovery.timerId = setTimeout(() => {
      recovery.timerId = null;
      startRestart(recovery);
    }, plan.delayMs);
  };

  // Fetches a fresh descriptor for the item and attaches it through the same
  // path as a settings switch: the place is parked in pendingResumeRef, then
  // setDescriptor replaces the descriptor while status stays "ready". The place
  // is read right before setDescriptor, because the old stream plays on until
  // then, and is stored as the recovery's place for later attempts. The old
  // hls.js instance stays alive until the replacement tears it down. A rejected
  // fetch counts as a failed attempt.
  const startRestart = (recovery: ActiveRecovery) => {
    if (recoveryRef.current !== recovery) {
      return;
    }
    recovery.phase = "fetching";
    recoveryBudgetRef.current = recordRestartStart(
      recoveryBudgetRef.current,
      Date.now(),
    );
    let request: Promise<WatchDescriptor>;
    try {
      request = fetchDescriptorForRoute(currentTuningRef.current);
    } catch (err: unknown) {
      request = Promise.reject(err);
    }
    void request.then(
      (result) => {
        if (recoveryRef.current !== recovery) {
          return;
        }
        recovery.phase = "attaching";
        recovery.position = resolveRecoveryPosition(recovery);
        recovery.attached = true;
        recovery.fetchError = null;
        pendingResumeRef.current = {
          position: recovery.position,
          wasPlaying: recovery.wasPlaying,
        };
        setDescriptor(result);
      },
      (err: unknown) => {
        if (recoveryRef.current !== recovery) {
          return;
        }
        recoveryBudgetRef.current = recordAttemptFailed(
          recoveryBudgetRef.current,
        );
        const message = err instanceof Error ? err.message : "unknown error";
        recovery.fetchError = message;
        scheduleRestart(recovery, `a failed descriptor fetch (${message})`);
      },
    );
  };

  // A fatal hls.js error on an item whose stream was working. During an attempt
  // (phase "attaching") it is that attempt failing, and the next one is planned.
  // Otherwise it starts a recovery. If a seek is parked in pendingResumeRef,
  // its place and play intent are the recovery's. That happens when a settings
  // switch or the Cast handoff attached a stream that failed before its
  // manifest applied the seek, and the HLS effect had paused the element in the
  // meantime. Reading the element then would restart a playing viewer paused.
  // With nothing parked, the play intent is read from the element now, because
  // it resets once hls.js tears the stream down, and so is a first value for the
  // place. The place is read again when an attempt attaches.
  const handleRecoverableFatalError = (input: FatalRecoveryInput) => {
    if (settingsSwitchesInFlightRef.current > 0) {
      return;
    }
    const active = recoveryRef.current;
    if (active !== null) {
      if (active.phase !== "attaching") {
        return;
      }
      active.failures.push(input.failure);
      active.lastAttach = {
        attempts: input.attemptFailures,
        hadLocalUrl: input.hadLocalUrl,
      };
      active.fetchError = null;
      recoveryBudgetRef.current = recordAttemptFailed(
        recoveryBudgetRef.current,
      );
      scheduleRestart(active, describeFatalForLog(input.failure));
      return;
    }

    const video = videoRef.current;
    const parked = pendingResumeRef.current;
    let position = 0;
    let wasPlaying = video === null ? true : !video.paused;
    if (parked !== null) {
      position = parked.position;
      wasPlaying = parked.wasPlaying;
    } else {
      const live = video === null ? 0 : video.currentTime;
      const kept = lastGoodPositionRef.current;
      if (Number.isFinite(live) && live > 0) {
        position = live;
      } else if (kept !== null && Number.isFinite(kept) && kept > 0) {
        position = kept;
      }
    }
    const recovery: ActiveRecovery = {
      position,
      wasPlaying,
      attached: false,
      phase: "waiting",
      timerId: null,
      failures: [input.failure],
      hadLocalUrl: input.hadLocalUrl,
      lastAttach: {
        attempts: input.attemptFailures,
        hadLocalUrl: input.hadLocalUrl,
      },
      fetchError: null,
    };
    recoveryRef.current = recovery;
    setReconnecting(true);
    // A non-fatal error only reaches here when the session had gone stale, so
    // the warning names that and the silence. A fatal error keeps the 56.2
    // wording.
    const described = describeFatalForLog(input.failure);
    const lastSignOfLife = lastSignOfLifeRef.current;
    const reason =
      input.failure.data.fatal === false && lastSignOfLife !== null
        ? `a stale session, ${Math.floor((Date.now() - lastSignOfLife) / 1000)} s since the last sign of life (${described})`
        : described;
    scheduleRestart(recovery, reason);
  };

  // A stream buffered a fragment. When it is the attempt of a recovery, the
  // recovery is over and the failed streak starts again at 0. The banner stays
  // until the element plays, except for a restart that lands paused, which
  // never plays by itself.
  const handleStreamBuffered = () => {
    const recovery = recoveryRef.current;
    if (recovery === null || recovery.phase !== "attaching") {
      return;
    }
    recoveryRef.current = null;
    recoveryBudgetRef.current = recordAttemptRecovered(
      recoveryBudgetRef.current,
    );
    if (!recovery.wasPlaying) {
      setReconnecting(false);
    }
  };
  // The HLS effect runs once per descriptor and reads the latest handlers here.
  recoveryHandlersRef.current = {
    onFatalError: handleRecoverableFatalError,
    onStreamBuffered: handleStreamBuffered,
  };

  // Hides the banner when the restarted stream plays. A recovery that is still
  // running ignores the event, since the old stream may fire one while it dies.
  useEffect(() => {
    if (!reconnecting) {
      return;
    }
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const onPlaying = () => {
      if (recoveryRef.current === null) {
        setReconnecting(false);
      }
    };
    video.addEventListener("playing", onPlaying);
    return () => {
      video.removeEventListener("playing", onPlaying);
    };
  }, [reconnecting]);

  // Load the play descriptor. Runs on mount and on any route-param change, so
  // navigating from one episode to the next re-enters here.
  //
  // Picking the endpoint is the whole reason the three routes exist: an episode
  // and a Library item are fetched by raw Plex ratingKey, a movie off a title
  // page by TMDB id (the server asks Seerr for the ratingKey). A param that
  // didn't validate leaves `load` null and the page goes straight to its error
  // state without a round trip.
  //
  // Also the reset point for everything that's per-title: pending seeks, the
  // latched Cast position, and the applied subtitle all get cleared, and the
  // resume dialog is re-decided from the new descriptor's viewOffsetMs. A
  // stored subtitle preference may then be re-applied (PUT + re-fetch) before
  // status flips to ready, so the first play already has burn-in.
  useEffect(() => {
    let load: (() => Promise<WatchDescriptor>) | null = null;
    if (isEpisode) {
      if (ratingKey !== null) {
        load = () => fetchEpisodeWatch(ratingKey);
      }
    } else if (isItem) {
      if (itemRatingKey !== null) {
        load = () => fetchItemWatch(itemRatingKey);
      }
    } else if (tmdbId !== null) {
      load = () => fetchMovieWatch(tmdbId);
    }

    if (load === null) {
      setDescriptor(null);
      setStatus("error");
      setError(isEpisode ? "Invalid episode" : "Invalid title");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);
    setDescriptor(null);
    setResumeDialog(null);
    pendingResumeRef.current = null;
    lastRemotePositionRef.current = null;
    lastGoodPositionRef.current = null;
    appliedSubtitleIdRef.current = null;
    // Per-item recovery state: a new item starts with no tuning, no working
    // stream yet, and a fresh restart budget.
    currentTuningRef.current = undefined;
    streamEstablishedRef.current = false;
    lastSignOfLifeRef.current = null;
    recoveryBudgetRef.current = createRecoveryBudget();

    void load()
      .then(async (result) => {
        if (cancelled) {
          return;
        }

        // Re-apply a remembered language before committing the descriptor, so
        // the first transcode already has burn-in. Failures here must not take
        // the page to error — fall back to the original result (Off).
        let finalResult = result;
        const pref = readStoredSubtitlePreference();
        if (pref !== null) {
          const match = resolveSubtitleForPreference(
            result.streams.subtitle,
            pref,
          );
          if (match !== null) {
            try {
              await selectSubtitle(result.ratingKey, match.id);
              if (cancelled) {
                return;
              }
              appliedSubtitleIdRef.current = match.id;
              finalResult = await load();
              if (cancelled) {
                return;
              }
            } catch (err: unknown) {
              console.error("Failed to re-apply subtitle preference", err);
              appliedSubtitleIdRef.current = null;
              finalResult = result;
            }
          }
        }

        if (cancelled) {
          return;
        }
        setDescriptor(finalResult);
        setResumeDialog(
          shouldOfferResumeDialog(finalResult)
            ? resumeDialogFromDescriptor(finalResult)
            : null,
        );
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setDescriptor(null);
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to load stream");
      });

    // Leaving the item, by navigation or unmount, also ends a recovery that is
    // waiting or fetching for it.
    return () => {
      cancelled = true;
      cancelRecovery();
    };
  }, [isEpisode, isItem, ratingKey, itemRatingKey, tmdbId, cancelRecovery]);

  // Prefetch the next episode so auto-advance can navigate without waiting.
  // Soft-fail: a null/failed result just disables advance for this episode.
  // GET /api/watch/episode/:ratingKey/next, and only for the episode route.
  useEffect(() => {
    if (!isEpisode || ratingKey === null) {
      setNextEpisode(null);
      return;
    }

    let cancelled = false;
    setNextEpisode(null);
    void fetchNextEpisode(ratingKey).then((next) => {
      if (!cancelled) {
        setNextEpisode(next);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isEpisode, ratingKey]);

  // Prefetch the previous episode for the link under the player. Separate from
  // the next-episode effect. Soft-fail: null just hides that link.
  useEffect(() => {
    if (!isEpisode || ratingKey === null) {
      setPreviousEpisode(null);
      return;
    }

    let cancelled = false;
    setPreviousEpisode(null);
    void fetchPreviousEpisode(ratingKey).then((previous) => {
      if (!cancelled) {
        setPreviousEpisode(previous);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isEpisode, ratingKey]);

  // Dismiss is per-episode; a new ratingKey brings the card back.
  // Also reset when navigating between item plays.
  // Zeroing the clock matters as much: showUpNext requires duration > 0, so the
  // card can't flash on the new title off the old title's remaining time.
  useEffect(() => {
    setUpNextDismissed(false);
    setPlaybackClock({ currentTime: 0, duration: 0 });
  }, [ratingKey, itemRatingKey]);

  // Drive the Up Next window from the video clock (no separate interval).
  // Owns the timeupdate / durationchange / loadedmetadata listeners and drops
  // them when the descriptor changes. Until the element reports a finite
  // duration of its own, the descriptor's durationMs stands in, so the Up Next
  // maths has something to work with from the first tick.
  useEffect(() => {
    if (descriptor === null) {
      return;
    }
    const video = videoRef.current;
    if (video === null) {
      return;
    }

    const fallbackDuration =
      typeof descriptor.durationMs === "number" &&
      Number.isFinite(descriptor.durationMs) &&
      descriptor.durationMs > 0
        ? descriptor.durationMs / 1000
        : 0;

    const sync = () => {
      const duration =
        Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : fallbackDuration;
      setPlaybackClock({
        currentTime: video.currentTime,
        duration,
      });
    };

    sync();
    video.addEventListener("timeupdate", sync);
    video.addEventListener("durationchange", sync);
    video.addEventListener("loadedmetadata", sync);
    return () => {
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("durationchange", sync);
      video.removeEventListener("loadedmetadata", sync);
    };
  }, [descriptor]);

  // Report playback timeline to Plex (resume position / watched state). Bound to
  // ratingKey only so quality/audio switches don't restart the heartbeat.
  // While casting, this local <video> reporter is inert. The torn-down element
  // reads currentTime 0 and must not overwrite a good resume point.
  //
  // Owns six media listeners, pagehide and visibilitychange, and one interval,
  // and drops all of them on cleanup. Player events map onto the three states
  // POST /api/watch/timeline accepts: playing on play and on a throttled seek,
  // paused on pause and when the tab goes hidden, stopped on ended and on the
  // way out. This is what makes the Continue Watching rail and the resume
  // dialog agree with the TV.
  //
  // Every report carries a real position or nothing. The position is the live
  // element time when it is above 0, else lastGoodPositionRef, and a report is
  // skipped when neither is above 0. A skipped paused or stopped report logs
  // one console.warn. emptied stops the heartbeat, because hls.js resets the
  // element on teardown (media.load() puts the position at 0) without firing
  // a pause event, and the next playing starts it again.
  useEffect(() => {
    const ratingKey = descriptor?.ratingKey;
    if (ratingKey === undefined || ratingKey === "") {
      return;
    }
    if (castReportingRef.current) {
      return;
    }

    const video = videoRef.current;
    if (video === null) {
      return;
    }

    let heartbeatId: ReturnType<typeof setInterval> | null = null;
    let lastSeekReportAt = 0;
    let finalStoppedSent = false;

    const clearHeartbeat = () => {
      if (heartbeatId !== null) {
        clearInterval(heartbeatId);
        heartbeatId = null;
      }
    };

    const resolveDurationMs = (): number =>
      resolveTimelineDurationMs(video.duration, timelineDurationMsRef.current);

    // Remembers the element's position while it is a real one. 0 is what the
    // element reads after a teardown, so it is never stored.
    const noteGoodPosition = (): void => {
      const live = video.currentTime;
      if (Number.isFinite(live) && live > 0) {
        lastGoodPositionRef.current = live;
      }
    };

    // The live position when above 0, else the last real one, else 0.
    const resolveTimeMs = (): number => {
      const live = video.currentTime;
      if (Number.isFinite(live) && live > 0) {
        return Math.round(live * 1000);
      }
      const kept = lastGoodPositionRef.current;
      if (kept !== null && Number.isFinite(kept) && kept > 0) {
        return Math.round(kept * 1000);
      }
      return 0;
    };

    // Nothing goes out at position 0. A paused or stopped report skipped for
    // that reason is logged once, with the state and no identifiers. Playing
    // reports and heartbeat ticks skip silently.
    const sendTimeline = (state: TimelineState, useBeacon = false): void => {
      const timeMs = resolveTimeMs();
      if (timeMs <= 0) {
        if (state !== "playing") {
          console.warn(
            `Timeline ${state} report skipped: no playback position was known.`,
          );
        }
        return;
      }
      sendTimelinePayload(
        buildTimelinePayload(ratingKey, state, timeMs, resolveDurationMs()),
        useBeacon,
      );
    };

    // Latched: pagehide and the effect cleanup can both fire on the way out,
    // and Plex should hear "stopped" exactly once.
    const sendFinalStopped = (): void => {
      if (finalStoppedSent) {
        return;
      }
      finalStoppedSent = true;
      clearHeartbeat();
      sendTimeline("stopped", true);
    };

    const startHeartbeat = () => {
      clearHeartbeat();
      heartbeatId = setInterval(() => {
        sendTimeline("playing");
      }, TIMELINE_HEARTBEAT_MS);
    };

    const onPlaying = () => {
      noteGoodPosition();
      sendTimeline("playing");
      startHeartbeat();
    };

    const onPause = () => {
      noteGoodPosition();
      clearHeartbeat();
      sendTimeline("paused");
    };

    // Report the new position after a scrub, throttled, since dragging the
    // scrubber lands a lot of these. A seek that lands on 0 sends nothing when
    // no real position is known yet, and that return leaves the throttle
    // window open. After something has played, a seek to 0 sends "playing"
    // with the last real position, so Plex keeps the previous place until the
    // next report.
    const onSeeked = () => {
      noteGoodPosition();
      const now = Date.now();
      if (now - lastSeekReportAt < TIMELINE_SEEK_THROTTLE_MS) {
        return;
      }
      if (resolveTimeMs() <= 0) {
        return;
      }
      lastSeekReportAt = now;
      sendTimeline("playing");
    };

    const onEnded = () => {
      clearHeartbeat();
      sendTimeline("stopped");
    };

    // hls.js teardown resets the element with media.load(), which fires
    // emptied and no pause. Without this the heartbeat would keep ticking
    // after the player is gone.
    const onEmptied = () => {
      clearHeartbeat();
    };

    const onPageHide = () => {
      sendFinalStopped();
    };

    // Backgrounding the tab banks the position with a beacon, because the page
    // may not get another chance to talk to us.
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        sendTimeline("paused", true);
      }
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("ended", onEnded);
    video.addEventListener("timeupdate", noteGoodPosition);
    video.addEventListener("emptied", onEmptied);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("timeupdate", noteGoodPosition);
      video.removeEventListener("emptied", onEmptied);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // Handing off to the cast reporter — do not beacon the torn-down video's 0.
      if (castReportingRef.current) {
        clearHeartbeat();
        return;
      }
      sendFinalStopped();
    };
  }, [descriptor?.ratingKey, castUi.connected, castRemote.isActive]);

  // Cast-session timeline reporter. Active only while castRemote.isActive; uses
  // the receiver clock so a cast viewing drives resume / watched like local play.
  //
  // Same shape as the local reporter above and mutually exclusive with it, but
  // there are no media events to hang off. State changes arrive through
  // castTimelineBridgeRef instead, driven by the RemotePlayer subscription in
  // the next effect. Every send is guarded against a zero position, because the
  // receiver reports 0 both before it loads and after it disconnects, and
  // writing that back would wipe out a real resume point.
  useEffect(() => {
    const ratingKey = descriptor?.ratingKey;
    if (ratingKey === undefined || ratingKey === "" || !castRemote.isActive) {
      return;
    }

    let heartbeatId: ReturnType<typeof setInterval> | null = null;
    let finalStoppedSent = false;

    const clearHeartbeat = () => {
      if (heartbeatId !== null) {
        clearInterval(heartbeatId);
        heartbeatId = null;
      }
    };

    const resolveDurationMs = (): number =>
      resolveTimelineDurationMs(
        castRemoteRef.current.duration,
        timelineDurationMsRef.current,
      );

    const resolveTimeMs = (): number => {
      const live = castRemoteRef.current.currentTime;
      if (typeof live === "number" && Number.isFinite(live) && live > 0) {
        return Math.round(live * 1000);
      }
      // Disconnect may zero RemotePlayer before this cleanup runs; the latch
      // still holds the last good receiver position (handoff clears it later).
      const latched = lastRemotePositionRef.current;
      if (
        typeof latched === "number" &&
        Number.isFinite(latched) &&
        latched > 0
      ) {
        return Math.round(latched * 1000);
      }
      return 0;
    };

    const buildPayload = (state: TimelineState): TimelinePayload | null =>
      buildTimelinePayload(
        ratingKey,
        state,
        resolveTimeMs(),
        resolveDurationMs(),
      );

    const sendTimeline = (state: TimelineState, useBeacon = false): void => {
      sendTimelinePayload(buildPayload(state), useBeacon);
    };

    const sendFinalStopped = (): void => {
      if (finalStoppedSent) {
        return;
      }
      finalStoppedSent = true;
      clearHeartbeat();
      // Never beacon a bogus 0 after a real cast session with no latched time.
      if (resolveTimeMs() <= 0) {
        return;
      }
      sendTimeline("stopped", true);
    };

    const startHeartbeat = () => {
      clearHeartbeat();
      heartbeatId = setInterval(() => {
        sendTimeline("playing");
      }, TIMELINE_HEARTBEAT_MS);
    };

    const onPlaying = () => {
      sendTimeline("playing");
      startHeartbeat();
    };

    const onPaused = () => {
      clearHeartbeat();
      if (resolveTimeMs() <= 0) {
        return;
      }
      sendTimeline("paused");
    };

    const onPageHide = () => {
      sendFinalStopped();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        if (resolveTimeMs() <= 0) {
          return;
        }
        sendTimeline("paused", true);
      }
    };

    // Publish the bridge before anything else can call it.
    castTimelineBridgeRef.current = {
      onPlayingChange: (playing) => {
        if (playing) {
          onPlaying();
        } else {
          onPaused();
        }
      },
    };

    // Rejoining a session that's already rolling (page refresh, late subscribe)
    // gets no state-change event, so start the heartbeat here.
    if (castRemoteRef.current.playing) {
      onPlaying();
    }

    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      castTimelineBridgeRef.current = null;
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      sendFinalStopped();
    };
  }, [descriptor?.ratingKey, castRemote.isActive]);

  // Drive cast timeline playing/paused off RemotePlayer updates (same session).
  useEffect(() => {
    if (!castRemote.isActive) {
      return;
    }
    castTimelineBridgeRef.current?.onPlayingChange(castRemote.playing);
  }, [castRemote.isActive, castRemote.playing]);

  // Auto-advance on ended. Refs keep the listener current without rebinding
  // on every autoPlay / nextEpisode change.
  //
  // Three separate ways to not advance: the preference is off, the user hit
  // Dismiss on the Up Next card, or there's no next episode (last of the
  // series, or the prefetch failed). Navigating to the next ratingKey restarts
  // the whole page flow from the descriptor fetch.
  useEffect(() => {
    if (descriptor === null) {
      return;
    }
    const video = videoRef.current;
    if (video === null) {
      return;
    }

    const onEnded = () => {
      if (!autoPlayRef.current) {
        return;
      }
      if (upNextDismissedRef.current) {
        return;
      }
      const next = nextEpisodeRef.current;
      if (next === null) {
        return;
      }
      // State comes from episodeSwitchState.
      navigate(`/watch/episode/${next.ratingKey}`, {
        replace: true,
        state: episodeSwitchState(location, false),
      });
    };

    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("ended", onEnded);
    };
  }, [descriptor, navigate, location]);

  // Latch the receiver's playback position while casting so disconnect can
  // hand off to local resume (pendingResumeRef) instead of restarting at 0.
  useEffect(() => {
    if (!castRemote.isActive) {
      return;
    }
    const t = castRemote.currentTime;
    if (typeof t === "number" && Number.isFinite(t) && t > 0) {
      lastRemotePositionRef.current = t;
    }
  }, [castRemote.isActive, castRemote.currentTime]);

  // Must run BEFORE the hls effect below: when castUi.connected flips
  // true → false, seed pendingResumeRef so applyPendingResume seeks there
  // once the re-attached manifest parses.
  //
  // This is the "stop casting and the browser picks up where the TV got to"
  // half of the handoff. Effect order in the file is what makes it work, since
  // both effects wake on the same castUi.connected change. The latch is clamped
  // to the runtime so a receiver overshoot can't seek past the end.
  useEffect(() => {
    const connected = castUi.connected;
    if (wasCastConnectedRef.current && !connected) {
      const latched = lastRemotePositionRef.current;
      lastRemotePositionRef.current = null;
      if (
        typeof latched === "number" &&
        Number.isFinite(latched) &&
        latched > 0
      ) {
        let position = latched;
        const durationMs = timelineDurationMsRef.current;
        if (durationMs !== null && durationMs > 0) {
          const durationSec = durationMs / 1000;
          if (position > durationSec) {
            position = durationSec;
          }
        }
        if (Number.isFinite(position) && position > 0) {
          pendingResumeRef.current = { position, wasPlaying: true };
          // The local stream has not played yet and the element reads 0, so
          // the local reporter needs this position to report a real one if the
          // page is left before the stream starts.
          lastGoodPositionRef.current = position;
        }
      }
    }
    wasCastConnectedRef.current = connected;
  }, [castUi.connected]);

  // Wire up playback once a descriptor is ready. Tries the local connection
  // first and falls back to the remote one on a fatal hls.js error.
  // Quality/audio switches update descriptor in place (status stays "ready") so
  // the <video> stays mounted; pendingResumeRef carries position across rebuilds.
  // A restart after a failed stream takes the same path: a fresh descriptor is
  // set in place and this effect rebuilds the stream at the parked position.
  // While casting, tear down local hls.js so only the receiver consumes the
  // transcode session (one X-Plex-Session-Identifier).
  //
  // A fatal error is handled in one of three ways, see classifyFatalError. An
  // attach that buffered nothing fails over from local to remote once. A
  // waiting instance the viewer has already started does not: its media
  // playlist and first fragment both waited for the choice, so it has buffered
  // nothing, and before 56.7 the same failure restarted a working stream
  // (spec 4.7). It restarts at the chosen place instead of failing over to the
  // remote URL of the same session. A stream that was working (this attach or
  // an earlier one of the item buffered a fragment) is handed to the recovery
  // logic, which restarts it with a fresh descriptor, because Plex ends an
  // idle transcode about 181 s after its last request and the URLs of this
  // descriptor are dead after that. Anything else is the error state with the
  // connection report. A non-fatal fragLoadError or
  // fragLoadTimeOut starts that same recovery, and skips the failover, when the
  // session has been silent for more than STALE_SESSION_MS. The two URLs share
  // the dead session, so the remote URL of this descriptor is dead too. After
  // the hand-off this run ignores further errors and keeps its instance until
  // the next descriptor replaces it.
  //
  // While an instance sits idle it pings that session every 30 s, with no time
  // limit, so a pause in an open tab does not end the session. A ping that
  // finds the session dead stops the pings and makes the next fragment failure
  // restart at once. Cast and the native HLS path never attach hls.js, so they
  // never ping.
  //
  // An attach made while the Resume dialog is open loads nothing after the
  // manifest. The viewer's choice starts that instance at the chosen position.
  // Buffering from 0:00 behind the dialog could leave the resume request held
  // for minutes (spec E20). Starting at the chosen position makes the first
  // request that position, which is the request pattern a restart uses (spec
  // E21). A fatal error after that start, and before a fragment buffers,
  // restarts at the chosen place rather than failing over.
  //
  // This effect owns the hls.js instance and destroys it on cleanup. It's the
  // point where the descriptor stops being data and becomes a video stream:
  // hls.js loads a plex.direct URL that already carries the transient token, so
  // segments come from Plex over the LAN or over Plex's own remote address, not
  // through our origin.
  useEffect(() => {
    if (descriptor === null) {
      return;
    }

    // A Cast session is up, so the browser shouldn't be pulling segments at
    // all. Dropping the src (rather than just pausing) is what actually stops
    // the fetching; the receiver plays the DASH URLs from the same descriptor.
    if (castUi.connected) {
      // The receiver takes over, so a restart that is waiting has no stream
      // left to restore.
      cancelRecovery();
      const video = videoRef.current;
      if (video !== null) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      return;
    }

    const video = videoRef.current;
    if (video === null) {
      return;
    }

    // Plex advertises a LAN address only sometimes, so local can be null and
    // remote is the one that's always there.
    const localUrl = descriptor.hls.local;
    const remoteUrl = descriptor.hls.remote;
    const primaryUrl = localUrl ?? remoteUrl;

    // Single decision point for a stream that was allowed to load: apply a
    // parked seek (a settings restart, a cast handoff, or a recovery), sit
    // still because the Resume dialog is open, or just play. An instance held
    // for the dialog does not come through here. Its choice starts it at the
    // chosen position, including a choice parked before the manifest parsed.
    const applyPendingResume = () => {
      const pending = pendingResumeRef.current;
      if (pending !== null) {
        pendingResumeRef.current = null;
        try {
          video.currentTime = pending.position;
        } catch (err: unknown) {
          console.error("Resume seek failed", err);
        }
        if (pending.wasPlaying) {
          void video.play().catch((err: unknown) => {
            console.error("Resume play failed", err);
          });
        } else {
          video.pause();
        }
        return;
      }
      if (resumeDialogOpenRef.current) {
        video.pause();
        return;
      }
      void video.play().catch((err: unknown) => {
        console.error("Autoplay failed", err);
      });
    };

    // Safari (and other native HLS players) can play the manifest directly.
    // Note there's no local-to-remote fallback on this path: whatever primaryUrl
    // resolved to is what plays, and a browser with neither hls.js support nor
    // native HLS gets the error state.
    if (!Hls.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl") !== "") {
        if (pendingResumeRef.current !== null || resumeDialogOpenRef.current) {
          video.pause();
        }
        const onLoadedMetadata = () => {
          video.removeEventListener("loadedmetadata", onLoadedMetadata);
          applyPendingResume();
        };
        video.addEventListener("loadedmetadata", onLoadedMetadata);
        video.src = primaryUrl;
        return () => {
          video.removeEventListener("loadedmetadata", onLoadedMetadata);
          video.removeAttribute("src");
          video.load();
        };
      }
      setStatus("error");
      setError("Your browser can't play this stream");
      return;
    }

    let hls: Hls | null = null;
    let usedRemote = primaryUrl === remoteUrl;
    // True once this run handed an error to the recovery logic or to the error
    // state. Later errors from its instance are ignored, including the retries
    // that follow a stale fragment failure.
    let settled = false;
    // True once the current attach buffered a fragment. A failover attach
    // starts again at false.
    let attachBuffered = false;
    // Accumulate fatal errors across the local→remote failover. The first hls
    // instance is destroyed before the second starts, so replacing the message
    // (as the old code did) could only ever show the last failure.
    const attemptFailures: HlsAttemptFailure[] = [];

    if (pendingResumeRef.current !== null || resumeDialogOpenRef.current) {
      // Avoid briefly playing from 0:00 while the user chooses or a new
      // quality manifest loads.
      video.pause();
    }

    // Stops the current instance's pings and destroys it. The interval belongs
    // to that instance, so every place the run destroys one clears it here:
    // a fail-over, the give-up, and the effect cleanup (which also covers an
    // item change, Cast connecting, and a restart). The fake hls.js never
    // fires DESTROYING, so this does not listen for it.
    let stopInstanceKeepalive = (): void => {};
    let markAttachedDestroyed = (): void => {};
    const destroyAttachedInstance = () => {
      startHeldLoadRef.current = null;
      markAttachedDestroyed();
      stopInstanceKeepalive();
      hls?.destroy();
      hls = null;
    };

    // Fast-fail only the LOCAL master-manifest probe (~3s, no retries) so an
    // unreachable LAN plex.direct falls over to remote quickly. Fragment and
    // media-playlist timeouts stay at hls.js defaults — cold Plex transcodes
    // can take several seconds even on a reachable local link. Remote (and
    // primary-when-local-is-null) keeps patient default timeouts.
    const attach = (source: string, fastFail: boolean) => {
      attachBuffered = false;
      // This instance's own keepalive. lastFragmentAtMs starts when its
      // manifest parses and moves on each loaded fragment. A tick pings only
      // a paused element that is not seeking, and only when nothing has
      // loaded for 30 s. Fragments already prove the session is alive, and
      // hls.js's own retries cover a short blip. A playing or seeking element
      // that has loaded nothing is stuck, not idle: an alive ping would count
      // as a sign of life and hide that hang from the stale-session rule.
      // There is no cap (D3): the pings continue for as long as the paused
      // instance stays idle. A dead answer ends them, because that session
      // cannot come back.
      let stopped = false;
      let sessionDead = false;
      let pingInFlight = false;
      let warnedUnknown = false;
      let lastFragmentAtMs = 0;
      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
      const stopThisKeepalive = () => {
        stopped = true;
        if (keepaliveTimer !== null) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      };
      stopInstanceKeepalive = stopThisKeepalive;
      const sendKeepalive = async (): Promise<void> => {
        if (stopped || sessionDead || pingInFlight || video.ended || !video.paused || video.seeking) {
          return;
        }
        const now = Date.now();
        if (now - lastFragmentAtMs < KEEPALIVE_INTERVAL_MS) {
          return;
        }
        let url: string;
        try {
          url = buildPingUrl(source, descriptor.sessionId, descriptor.transient);
        } catch (err: unknown) {
          if (!warnedUnknown) {
            warnedUnknown = true;
            const reason = err instanceof Error ? err.message : "bad ping URL";
            console.warn(`Keepalive ping skipped: ${reason}`);
          }
          return;
        }
        pingInFlight = true;
        const result = await pingTranscodeSession(url);
        pingInFlight = false;
        if (stopped) {
          return;
        }
        if (result === "alive") {
          lastSignOfLifeRef.current = Date.now();
          return;
        }
        if (result === "dead") {
          sessionDead = true;
          stopThisKeepalive();
          return;
        }
        if (!warnedUnknown) {
          warnedUnknown = true;
          console.warn(
            `Keepalive ping: unknown result for ${redactStreamUrl(url)}`,
          );
        }
      };
      // While the Resume dialog is open, load nothing after the manifest. A
      // Resume clicked while hls.js was buffering from 0:00 left Plex holding
      // the request for the resume segment for minutes (spec E20). The
      // viewer's choice starts this instance at the chosen position, so the
      // first request is that position, the same request pattern a restart
      // uses (spec E21). hls.js ignores a startLoad position before the
      // manifest has parsed, so a choice made earlier is parked until then.
      const holdForResume = resumeDialogOpenRef.current;
      let manifestParsed = false;
      let loadStarted = false;
      let attachedDestroyed = false;
      markAttachedDestroyed = () => {
        attachedDestroyed = true;
      };
      const instance = new Hls({
        enableWorker: false,
        ...(holdForResume ? { autoStartLoad: false } : {}),
        ...(fastFail
          ? {
              manifestLoadPolicy: {
                default: {
                  maxTimeToFirstByteMs: 3000,
                  maxLoadTimeMs: 3000,
                  timeoutRetry: {
                    maxNumRetry: 0,
                    retryDelayMs: 0,
                    maxRetryDelayMs: 0,
                  },
                  errorRetry: {
                    maxNumRetry: 0,
                    retryDelayMs: 0,
                    maxRetryDelayMs: 0,
                  },
                },
              },
            }
          : {}),
      });
      hls = instance;
      const startHeldAt = (position: number): void => {
        if (!manifestParsed || attachedDestroyed) {
          pendingResumeRef.current = { position, wasPlaying: true };
          return;
        }
        if (loadStarted) {
          return;
        }
        loadStarted = true;
        pendingResumeRef.current = null;
        try {
          video.currentTime = position;
        } catch (err: unknown) {
          console.error("Resume seek failed", err);
        }
        instance.startLoad(position);
        void video.play().catch((err: unknown) => {
          console.error("Resume play failed", err);
        });
      };
      if (holdForResume) {
        startHeldLoadRef.current = startHeldAt;
      }
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const now = Date.now();
        lastSignOfLifeRef.current = now;
        if (!stopped) {
          lastFragmentAtMs = now;
          if (keepaliveTimer !== null) {
            clearInterval(keepaliveTimer);
          }
          keepaliveTimer = setInterval(() => {
            void sendKeepalive();
          }, KEEPALIVE_INTERVAL_MS);
        }
        manifestParsed = true;
        if (holdForResume) {
          const pending = pendingResumeRef.current;
          if (pending !== null) {
            startHeldAt(pending.position);
            return;
          }
          if (resumeDialogOpenRef.current) {
            video.pause();
            return;
          }
        }
        applyPendingResume();
      });
      hls.on(Hls.Events.FRAG_LOADED, () => {
        lastSignOfLifeRef.current = Date.now();
        lastFragmentAtMs = Date.now();
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        attachBuffered = true;
        streamEstablishedRef.current = true;
        if (!settled) {
          recoveryHandlersRef.current?.onStreamBuffered();
        }
      });
      // Records this error against the attach and hands it to the recovery
      // 56.2 starts for a fatal error. The run is settled first, so later
      // errors from this instance add nothing.
      const recoverFrom = (data: {
        type: unknown;
        details: unknown;
        fatal: unknown;
        url?: unknown;
        reason?: unknown;
        error?: unknown;
        response?: unknown;
      }) => {
        const connection: "local" | "remote" =
          localUrl !== null && source === localUrl ? "local" : "remote";
        const failure: HlsAttemptFailure = {
          connection,
          sourceUrl: source,
          data: {
            type: data.type,
            details: data.details,
            fatal: data.fatal,
            url: data.url,
            reason: data.reason,
            error: data.error,
            response: data.response,
          },
        };
        attemptFailures.push(failure);
        settled = true;
        recoveryHandlersRef.current?.onFatalError({
          failure,
          attemptFailures: [...attemptFailures],
          hadLocalUrl: localUrl !== null,
        });
      };
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (settled) {
          return;
        }
        if (!data.fatal) {
          const details = typeof data.details === "string" ? data.details : "";
          // A failed segment after a long silence is a dead session. It never
          // fails over: the remote URL belongs to the same session.
          if (
            (streamEstablishedRef.current || loadStarted) &&
            recoveryRef.current === null &&
            isStaleSessionError(
              { fatal: false, details },
              lastSignOfLifeRef.current,
              Date.now(),
              sessionDead,
            )
          ) {
            recoverFrom(data);
          }
          return;
        }
        const connection: "local" | "remote" =
          localUrl !== null && source === localUrl ? "local" : "remote";
        attemptFailures.push({
          connection,
          sourceUrl: source,
          data: {
            type: data.type,
            details: data.details,
            fatal: data.fatal,
            url: data.url,
            reason: data.reason,
            error: data.error,
            response: data.response,
          },
        });
        // On a fatal error, fall back local → remote once; a stream that was
        // working restarts with a fresh descriptor; anything else surfaces a
        // visible error rather than a silent dead player. A waiting instance
        // the viewer has started is that working stream. Its media playlist
        // and first fragment both waited for the choice, so it has buffered
        // nothing, and before 56.7 the same failure restarted a stream that
        // had buffered from 0:00 (spec 4.7). Do not fail over to the remote
        // URL of the same session.
        const failure = attemptFailures[attemptFailures.length - 1];
        const action = classifyFatalError({
          attachBuffered,
          failoverAvailable: !usedRemote && remoteUrl !== source && !loadStarted,
          streamEstablished: streamEstablishedRef.current || loadStarted,
        });
        if (action === "fail-over") {
          usedRemote = true;
          destroyAttachedInstance();
          attach(remoteUrl, false);
          return;
        }
        settled = true;
        if (action === "recover" && failure !== undefined) {
          recoveryHandlersRef.current?.onFatalError({
            failure,
            attemptFailures: [...attemptFailures],
            hadLocalUrl: localUrl !== null,
          });
          return;
        }
        destroyAttachedInstance();
        pendingResumeRef.current = null;
        const report = buildHlsPlaybackFailureReport({
          hadLocalUrl: localUrl !== null,
          attempts: attemptFailures,
        });
        console.error("HLS playback failed", report.logPayload);
        setStatus("error");
        setError(report.message);
      });
      hls.loadSource(source);
      hls.attachMedia(video);
    };

    attach(primaryUrl, primaryUrl === localUrl);

    const destroyThisRun = () => {
      destroyAttachedInstance();
    };
    destroyHlsRef.current = destroyThisRun;

    return () => {
      if (destroyHlsRef.current === destroyThisRun) {
        destroyHlsRef.current = null;
      }
      destroyThisRun();
    };
  }, [descriptor, castUi.connected, cancelRecovery]);

  // Hand the current title to the receiver once the Cast *session* is ready
  // (SESSION_STARTED / SESSION_RESUMED). CAST_STATE_CHANGED=CONNECTED can fire
  // before the Default Media Receiver accepts loadMedia.
  //
  // Owns the session subscription and any pending retry timers, and cancels
  // both on cleanup. The receiver gets DASH, not the HLS the browser plays, and
  // loadMediaOnCast does Plex's required /decision handshake first. A load that
  // throws ends the Cast session rather than leaving a connected device staring
  // at nothing.
  useEffect(() => {
    if (descriptor === null) {
      return;
    }

    const contentUrl = descriptor.dash.local ?? descriptor.dash.remote;
    const decisionUrl =
      descriptor.dashDecision.local ?? descriptor.dashDecision.remote;
    const title = descriptor.title;
    const subheading = descriptor.subheading;

    let cancelled = false;
    let loadedContentUrl: string | null = null;
    let loadedSession: cast.framework.CastSession | null = null;
    let inFlight = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const clearTimers = () => {
      for (const id of timers) {
        clearTimeout(id);
      }
      timers.clear();
    };

    const endSession = () => {
      if (window.cast?.framework) {
        cast.framework.CastContext.getInstance().endCurrentSession(true);
      }
    };

    const schedule = (fn: () => void, ms: number) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };

    // Same URL on the same session means the receiver already has it. Both
    // halves matter: subscribeSessionReady can fire again for a resumed
    // session, and a settings change produces a new URL for the same session.
    const alreadyLoadedFor = (
      session: cast.framework.CastSession | null,
    ): boolean =>
      loadedContentUrl === contentUrl &&
      loadedSession !== null &&
      session !== null &&
      loadedSession === session;

    const attemptLoad = (
      session: cast.framework.CastSession | null,
      isRetry: boolean,
    ) => {
      if (cancelled) {
        return;
      }
      if (!isRetry && alreadyLoadedFor(session)) {
        return;
      }
      if (inFlight) {
        return;
      }
      inFlight = true;

      void (async () => {
        if (cancelled) {
          inFlight = false;
          return;
        }

        try {
          await loadMediaOnCast({ contentUrl, decisionUrl, title, subheading });
          if (!cancelled) {
            loadedContentUrl = contentUrl;
            loadedSession = session;
          }
        } catch (err: unknown) {
          if (!cancelled) {
            console.warn("[cast] Failed to load media on receiver.", err);
            endSession();
          }
        } finally {
          inFlight = false;
        }
      })();

      // Cold Plex DASH transcodes can take well over a few seconds before the
      // receiver reports a media session. One retry at ~10s; if still nothing,
      // warn and leave the Cast session up (do not bounce back to local hls).
      schedule(() => {
        if (cancelled) {
          return;
        }
        const current =
          cast.framework.CastContext.getInstance().getCurrentSession();
        if (current === null) {
          return;
        }
        if (current.getMediaSession() !== null) {
          return;
        }
        if (!isRetry) {
          inFlight = false;
          attemptLoad(session, true);
          return;
        }
        console.warn(
          "[cast] Receiver has no media session after load retry; leaving Cast session active.",
        );
      }, 10_000);
    };

    const unsubscribe = subscribeSessionReady((session) => {
      attemptLoad(session, false);
    });

    return () => {
      cancelled = true;
      clearTimers();
      unsubscribe();
    };
  }, [descriptor]);

  // The control bar's auto-advance toggle. Sticks for next time.
  const onAutoPlayChange = (value: boolean) => {
    setAutoPlay(value);
    writeStoredAutoPlay(value);
  };

  // When the Up Next card is allowed to appear. Plex's credits marker fires it
  // early on shows that have one, and the last 30 seconds cover everything
  // else. Either way it needs a real duration and some runtime left, and it's
  // episodes only, with auto-advance on and Dismiss not already pressed.
  const remainingSec = playbackClock.duration - playbackClock.currentTime;
  const creditsOffsetMs = descriptor?.creditsOffsetMs ?? null;
  const atCredits =
    typeof creditsOffsetMs === "number" &&
    Number.isFinite(creditsOffsetMs) &&
    playbackClock.currentTime * 1000 >= creditsOffsetMs;
  // Credits marker (when present) OR the last-30s floor/fallback.
  const inUpNextWindow =
    atCredits || remainingSec <= UP_NEXT_WINDOW_SEC;
  const showUpNext =
    isEpisode &&
    autoPlay &&
    nextEpisode !== null &&
    playbackClock.duration > 0 &&
    remainingSec > 0 &&
    inUpNextWindow &&
    !upNextDismissed;

  // Stable across timeupdate re-renders so UpNextCard's local→remote image
  // fallback is not reset every tick.
  const thumbUrls = useMemo(
    () =>
      nextEpisode === null || descriptor === null
        ? []
        : buildThumbUrls(
            nextEpisode.thumb,
            descriptor.connections,
            descriptor.transient,
          ),
    [
      nextEpisode?.thumb,
      descriptor?.connections,
      descriptor?.transient,
    ],
  );

  // Up Next card. The countdown only appears inside the 30s window, so a
  // marker-triggered card sits there without a number until the clock catches
  // up. Play now jumps immediately; Dismiss also cancels the advance on ended.
  const upNextOverlay =
    showUpNext && nextEpisode !== null && descriptor !== null ? (
      <UpNextCard
        seasonNumber={nextEpisode.seasonNumber}
        episodeNumber={nextEpisode.episodeNumber}
        title={nextEpisode.title}
        thumbUrls={thumbUrls}
        secondsRemaining={
          remainingSec <= UP_NEXT_WINDOW_SEC
            ? Math.ceil(remainingSec)
            : null
        }
        onPlayNow={() => {
          // State comes from episodeSwitchState.
          navigate(`/watch/episode/${nextEpisode.ratingKey}`, {
            replace: true,
            state: episodeSwitchState(location, true),
          });
        }}
        onDismiss={() => {
          setUpNextDismissed(true);
        }}
      />
    ) : null;

  // Resume dialog, shown over a paused player when Plex had a position for this
  // user. Closing it counts as Resume, not Start over.
  const resumeOverlay =
    resumeDialog !== null ? (
      <ResumeDialog
        positionSeconds={resumeDialog.positionSeconds}
        durationSeconds={resumeDialog.durationSeconds}
        onResume={handleResumeFromSaved}
        onStartOver={handleStartOver}
        onClose={handleResumeFromSaved}
      />
    ) : null;

  // Connected but media not yet loaded/playing → starting; once the receiver
  // has real media state, keep the persistent "Playing on" label (incl. pause).
  const castMediaReady =
    castRemote.isActive &&
    (castRemote.playing ||
      castRemote.duration > 0 ||
      castRemote.currentTime > 0);
  const castStatusMode: "starting" | "playing" | null = !castUi.connected
    ? null
    : castMediaReady
      ? "playing"
      : "starting";
  // Up Next takes precedence when both could show.
  const castOverlay =
    castStatusMode !== null && !showUpNext ? (
      <CastStatusOverlay
        mode={castStatusMode}
        deviceName={castRemote.deviceName}
      />
    ) : null;

  // The recovery banner. The receiver owns playback while casting, so it
  // never shows then.
  const reconnectingOverlay =
    reconnecting && !castUi.connected ? <ReconnectingOverlay /> : null;

  // All the overlays go to PlayerControls as one node so they sit inside the
  // player frame and above the control bar.
  const playerOverlay = (
    <>
      {castOverlay}
      {reconnectingOverlay}
      {resumeOverlay}
      {upNextOverlay}
    </>
  );

  /**
   * Applies a change from the settings menu: quality, audio track, subtitles.
   *
   * This is the in-place transcode restart, and it's the reason the page never
   * drops back to "loading" here. Tuning lives in the Plex transcode URL, so
   * changing it means a whole new descriptor and a new session, but `status`
   * stays "ready" and the old descriptor holds until the new one lands.
   * The `<video>` element is never unmounted, which keeps PlayerControls'
   * listeners attached, and pendingResumeRef carries the position across the
   * rebuild so the switch looks like a short buffer instead of a restart.
   *
   * A restart after a fatal stream error uses this same path with the tuning
   * kept in currentTuningRef. A switch made while a restart is waiting cancels
   * that restart and parks the restart's place. Until a restart attempt has
   * attached, that place is the element's current time, because the old stream
   * keeps playing its buffer. After an attempt attached, it is the place stored
   * at that attach, because the teardown reset the element.
   *
   * Audio and subtitles are both stored with a part-level PUT before the
   * restart.
   *
   * @throws whatever the fetch, the subtitle PUT, or the audio PUT threw.
   * PlayerControls awaits this and leaves its highlights on the old selection
   * when it rejects.
   */
  const onStreamSettingsChange = async (
    settings: StreamSettings,
  ): Promise<void> => {
    const video = videoRef.current;
    if (video === null || descriptor === null) {
      // No-op for the player; reject so the settings highlights stay put.
      throw new Error("Player not ready");
    }

    // Bank where we are before anything tears down, including whether it was
    // playing, so a switch made while paused doesn't start playback. A restart
    // in progress has the better answer, since its stream is already gone.
    const recovering = recoveryRef.current;
    pendingResumeRef.current =
      recovering !== null
        ? {
            position: resolveRecoveryPosition(recovering),
            wasPlaying: recovering.wasPlaying,
          }
        : { position: video.currentTime, wasPlaying: !video.paused };
    cancelRecovery();
    settingsSwitchesInFlightRef.current += 1;

    try {
      // Burn-in is a part-level PUT, not a transcode URL param. Select (or
      // clear) before restarting so the new session picks up the choice.
      // Persist language (+ forced) rather than the stream id — ids are
      // part-scoped and won't match the next episode.
      if (settings.subtitleStreamId !== appliedSubtitleIdRef.current) {
        await selectSubtitle(
          descriptor.ratingKey,
          settings.subtitleStreamId ?? "0",
        );
        appliedSubtitleIdRef.current = settings.subtitleStreamId;
        if (settings.subtitleStreamId === null) {
          writeStoredSubtitlePreference(null);
        } else {
          const track = descriptor.streams.subtitle.find(
            (s) => s.id === settings.subtitleStreamId,
          );
          if (
            track !== undefined &&
            typeof track.language === "string" &&
            track.language.trim() !== ""
          ) {
            writeStoredSubtitlePreference({
              language: track.language,
              forced: track.forced,
            });
          }
        }
      }

      // Audio is a part-level PUT, not a transcode URL param. Store the choice
      // before restarting so the new session plays it.
      const audioStreamID = audioIdToSelect(
        settings.audioStreamId,
        descriptor.streams.audio,
      );
      if (audioStreamID !== null) {
        await selectAudio(descriptor.ratingKey, audioStreamID);
      }

      // Re-enter the same endpoint this page loaded from, now with tuning. The
      // route decides which one, exactly as it did on mount.
      const tuning = buildWatchTuning(settings);
      currentTuningRef.current = tuning;
      const result = await fetchDescriptorForRoute(tuning);
      // Keep status "ready" and the existing descriptor until the new one
      // arrives so the <video> (and PlayerControls listeners) stay mounted.
      setDescriptor(result);
    } catch (err: unknown) {
      // A failed switch drops the parked seek and takes the whole page to the
      // error state. Rethrowing is what leaves the settings panel highlighting
      // the setting that's actually playing.
      pendingResumeRef.current = null;
      setStatus("error");
      setError(
        err instanceof Error ? err.message : "Failed to switch stream settings",
      );
      throw err;
    } finally {
      settingsSwitchesInFlightRef.current -= 1;
    }
  };

  return (
    <main className="page page-wide page-centered">
      {/* Header: Back pops to the page before the player, or replaces this
          entry with the Library when the player opened the visit. It's the
          same Back pill as the title page's, plus the display strings the
          server already shaped. For an episode the title is the show and the
          subheading is "S1E1 · Pilot"; for a movie it's the title and the
          year. */}
      <header className="watch-header">
        <BackControl className="back-link">
          <BackIcon />
          Back
        </BackControl>
        {status === "ready" && descriptor !== null && descriptor.title ? (
          <div className="watch-header-titles">
            <h1 className="watch-title">{descriptor.title}</h1>
            {descriptor.subheading ? (
              <p className="watch-subheading">{descriptor.subheading}</p>
            ) : null}
          </div>
        ) : null}
      </header>

      {/* Waiting on the descriptor. Only the first load lands here; a settings
          switch stays in the "ready" branch below. */}
      {status === "loading" ? (
        <p className="muted">Loading stream…</p>
      ) : null}

      {/* The backend's own message where there is one, so "not playable" or
          "re-login required" reaches the user instead of a generic failure. */}
      {status === "error" ? (
        <div className="stats-error">
          <p className="error watch-playback-diag">
            {error ?? "Failed to load stream"}
          </p>
          <BackControl className="btn secondary">Back</BackControl>
        </div>
      ) : null}

      {/* The player. PlayerControls wraps the <video> rather than rendering it,
          so the element below is the one videoRef points at and the one every
          effect above attaches to. Audio and subtitle tracks come from the
          descriptor, the auto-play toggle only exists for episodes, and
          `remote` is what lets the same bar drive a Chromecast. */}
      {status === "ready" && descriptor !== null ? (
        <div className="watch-player-frame">
          <PlayerControls
            videoRef={videoRef}
            durationMs={descriptor.durationMs}
            audioTracks={descriptor.streams.audio}
            subtitleTracks={descriptor.streams.subtitle}
            initialSubtitleId={appliedSubtitleIdRef.current}
            onStreamSettingsChange={onStreamSettingsChange}
            autoPlay={isEpisode ? autoPlay : undefined}
            onAutoPlayChange={isEpisode ? onAutoPlayChange : undefined}
            remote={castRemote}
            enterFullscreenOnMount={enterFullscreenOnMount}
            overlay={playerOverlay}
          >
            <video
              ref={videoRef}
              className="watch-player"
              playsInline
            />
          </PlayerControls>
        </div>
      ) : null}
      {/* State comes from episodeSwitchState. */}
      {isEpisode && status === "ready" && descriptor !== null ? (
        <EpisodeNav
          previous={previousEpisode}
          next={nextEpisode}
          linkState={episodeSwitchState(location, false)}
        />
      ) : null}
    </main>
  );
}
