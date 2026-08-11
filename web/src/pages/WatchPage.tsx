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
// opens the resume dialog, creditsOffsetMs fires Up Next, streams.audio and
// streams.subtitle fill the settings menu, and POST /api/watch/timeline reports
// progress back so Plex and the TV in the other room agree on where you stopped.
//
// Casting is a second playback target rather than a second page. Once a Cast
// session connects, local hls.js is torn down and the receiver plays Plex's
// DASH instead, with a separate reporter driving the timeline off the receiver
// clock. Disconnecting hands the position back to the local <video>.

import Hls from "hls.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  fetchEpisodeWatch,
  fetchItemWatch,
  fetchMovieWatch,
  fetchNextEpisode,
  reportTimeline,
  reportTimelineBeacon,
  selectSubtitle,
  type NextEpisode,
  type SubtitleStream,
  type TimelineState,
  type WatchConnections,
  type WatchDescriptor,
  type WatchTuning,
} from "../api/watch";
import { CastStatusOverlay } from "../components/CastStatusOverlay";
import {
  PlayerControls,
  type QualityId,
  type StreamSettings,
} from "../components/PlayerControls";
import { ResumeDialog } from "../components/ResumeDialog";
import { UpNextCard } from "../components/UpNextCard";
import { loadMediaOnCast } from "../cast/loadMediaOnCast";
import { subscribeSessionReady } from "../cast/subscribeSessionReady";
import { useCastPlayer } from "../cast/useCastPlayer";
import { useCastState } from "../cast/useCastState";

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
// param. onStreamSettingsChange handles that separately.
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
  // Previous value of castUi.connected, so the true-to-false edge is detectable.
  const wasCastConnectedRef = useRef(false);
  // Last subtitleStreamId successfully applied via PUT. Avoids redundant
  // selects when only quality/audio change. Starts null each item load, then
  // may be set from the stored language preference before status goes ready
  // (or by an in-episode switch). Not a mirror of whatever Plex had selected
  // on its own.
  const appliedSubtitleIdRef = useRef<string | null>(null);
  const [descriptor, setDescriptor] = useState<WatchDescriptor | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [autoPlay, setAutoPlay] = useState(readStoredAutoPlay);
  const [nextEpisode, setNextEpisode] = useState<NextEpisode | null>(null);
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
  autoPlayRef.current = autoPlay;
  nextEpisodeRef.current = nextEpisode;
  upNextDismissedRef.current = upNextDismissed;
  timelineDurationMsRef.current = descriptor?.durationMs ?? null;
  resumeDialogOpenRef.current = resumeDialog !== null;

  // Seek to a position and start playing. Only seeks straight away when the
  // element already has metadata. Otherwise the seek is parked in
  // pendingResumeRef, and applyPendingResume applies it once the manifest
  // parses.
  const beginPlaybackAt = useCallback((position: number) => {
    const video = videoRef.current;
    if (video === null) {
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
    appliedSubtitleIdRef.current = null;

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

    return () => {
      cancelled = true;
    };
  }, [isEpisode, isItem, ratingKey, itemRatingKey, tmdbId]);

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
  // While casting, this local <video> reporter is inert — the torn-down element
  // reads currentTime 0 and must not overwrite a good resume point.
  //
  // Owns four media listeners, pagehide and visibilitychange, and one interval,
  // and drops all of them on cleanup. Player events map onto the three states
  // POST /api/watch/timeline accepts: playing on play and on a throttled seek,
  // paused on pause and when the tab goes hidden, stopped on ended and on the
  // way out. This is what makes the Continue Watching rail and the resume
  // dialog agree with the TV.
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

    const resolveTimeMs = (): number =>
      Math.max(0, Math.round(video.currentTime * 1000));

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
      sendTimeline("playing");
      startHeartbeat();
    };

    const onPause = () => {
      clearHeartbeat();
      sendTimeline("paused");
    };

    // Report the new position after a scrub, throttled, since dragging the
    // scrubber lands a lot of these.
    const onSeeked = () => {
      const now = Date.now();
      if (now - lastSeekReportAt < TIMELINE_SEEK_THROTTLE_MS) {
        return;
      }
      lastSeekReportAt = now;
      sendTimeline("playing");
    };

    const onEnded = () => {
      clearHeartbeat();
      sendTimeline("stopped");
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
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("ended", onEnded);
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
      navigate(`/watch/episode/${next.ratingKey}`);
    };

    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("ended", onEnded);
    };
  }, [descriptor, navigate]);

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
        }
      }
    }
    wasCastConnectedRef.current = connected;
  }, [castUi.connected]);

  // Wire up playback once a descriptor is ready. Tries the local connection
  // first and falls back to the remote one on a fatal hls.js error.
  // Quality/audio switches update descriptor in place (status stays "ready") so
  // the <video> stays mounted; pendingResumeRef carries position across rebuilds.
  // While casting, tear down local hls.js so only the receiver consumes the
  // transcode session (one X-Plex-Session-Identifier).
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

    // Single decision point for "the stream is ready, now what". Either apply a
    // parked seek (resume, settings restart, cast handoff), or sit still
    // because the resume dialog is asking the user, or just play.
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
    // Accumulate fatal errors across the local→remote failover. The first hls
    // instance is destroyed before the second starts, so replacing the message
    // (as the old code did) could only ever show the last failure.
    const attemptFailures: HlsAttemptFailure[] = [];

    if (pendingResumeRef.current !== null || resumeDialogOpenRef.current) {
      // Avoid briefly playing from 0:00 while the user chooses or a new
      // quality manifest loads.
      video.pause();
    }

    // Fast-fail only the LOCAL master-manifest probe (~3s, no retries) so an
    // unreachable LAN plex.direct falls over to remote quickly. Fragment and
    // media-playlist timeouts stay at hls.js defaults — cold Plex transcodes
    // can take several seconds even on a reachable local link. Remote (and
    // primary-when-local-is-null) keeps patient default timeouts.
    const attach = (source: string, fastFail: boolean) => {
      hls = new Hls({
        enableWorker: false,
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
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        applyPendingResume();
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) {
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
        // On a fatal error, fall back local → remote once; if remote also
        // fails, surface a visible error rather than a silent dead player.
        if (!usedRemote && remoteUrl !== source) {
          usedRemote = true;
          hls?.destroy();
          attach(remoteUrl, false);
          return;
        }
        hls?.destroy();
        hls = null;
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

    return () => {
      hls?.destroy();
      hls = null;
    };
  }, [descriptor, castUi.connected]);

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
          navigate(`/watch/episode/${nextEpisode.ratingKey}`);
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

  // All three overlays go to PlayerControls as one node so they sit inside the
  // player frame and above the control bar.
  const playerOverlay = (
    <>
      {castOverlay}
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
   * @throws whatever the fetch or the subtitle PUT threw. PlayerControls awaits
   * this and leaves its highlights on the old selection when it rejects.
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
    // playing, so a switch made while paused doesn't start playback.
    pendingResumeRef.current = {
      position: video.currentTime,
      wasPlaying: !video.paused,
    };

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

      // Re-enter the same endpoint this page loaded from, now with tuning. The
      // route decides which one, exactly as it did on mount.
      const tuning = buildWatchTuning(settings);
      let result: WatchDescriptor;
      if (isEpisode) {
        if (ratingKey === null) {
          throw new Error("Invalid episode");
        }
        result = await fetchEpisodeWatch(ratingKey, tuning);
      } else if (isItem) {
        if (itemRatingKey === null) {
          throw new Error("Invalid title");
        }
        result = await fetchItemWatch(itemRatingKey, tuning);
      } else {
        if (tmdbId === null) {
          throw new Error("Invalid title");
        }
        result = await fetchMovieWatch(tmdbId, tuning);
      }
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
    }
  };

  return (
    <main className="page page-wide">
      {/* Header: back out to "/" (which redirects to the Library), plus the
          display strings the server already shaped. For an episode the title is
          the show and the subheading is "S1E1 · Pilot"; for a movie it's the
          title and the year. */}
      <header className="watch-header">
        <Link to="/" className="watch-back-link">
          ← Back
        </Link>
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
          <Link to="/" className="btn secondary">
            Back
          </Link>
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
    </main>
  );
}
