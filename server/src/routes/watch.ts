// Playback. This is the entrypoint for every "press play" in the app, mounted
// at /api/watch behind requireAuth. Eight endpoints:
//
//   GET /continue                 the Continue Watching rail
//   GET /movie/:tmdbId            play descriptor for a movie, by TMDB id
//   GET /tv/:tmdbId/episodes      episode list for a show
//   GET /episode/:ratingKey       play descriptor for an episode
//   GET /episode/:ratingKey/next  what auto-advances after this one
//   GET /item/:ratingKey          play descriptor for any Plex item
//   PUT /subtitle/:ratingKey      pick or clear the burned-in subtitle
//   POST /timeline                report progress back to Plex
//
// The important thing here is what a play descriptor is. Video does not go
// through the Cloudflare Tunnel. Proxying a movie through the edge would be
// slow and outside the terms for that path, so instead the server mints a
// short-lived Plex TRANSIENT token from the user's stored token, resolves
// Plex's own plex.direct addresses, and hands the browser URLs that point
// straight at the Plex server. Control plane through the tunnel, video direct.
//
// That means the transient token is returned to the browser in full, which is
// the one place in this codebase where a Plex credential crosses that line. It
// has to be: the player authenticates to Plex itself. The durable token never
// leaves the backend.
//
// Two id systems collide here. /movie/:tmdbId takes a TMDB id and asks Seerr
// for the matching Plex ratingKey; the ratingKey routes skip that hop because
// the browser already has one from the library or the episode list.
//
// Upstreams: Plex (metadata, connection resolve, transient mint, timeline
// reporting) and Seerr, purely for the TMDB-to-ratingKey join.

import { randomUUID } from "node:crypto";
import { Router } from "express";
import {
  PlexConnectionError,
  type PlexConnectionResolver,
} from "../plex/connection";
import type { SharedServerAccessResolver } from "../plex/sharedServerAccess";
import { buildDashUrl, buildDashDecisionUrl, buildHlsUrl } from "../plex/transcodeUrl";
import {
  PlexTransientError,
  type TransientTokenMinter,
} from "../plex/transientToken";
import type {
  AudioStream,
  PlexServerClient,
  SubtitleStream,
} from "../plex/server";
import type { MediaStatusProvider } from "../seerr/mediaStatusProvider";
import { mediaStatusFromCode } from "../seerr/client";
import { readPlexToken, type SessionPayload } from "../session";

export type WatchRouterDeps = {
  plexConnection: PlexConnectionResolver;
  transientMinter: TransientTokenMinter;
  mediaStatus: MediaStatusProvider;
  plexServer: PlexServerClient;
  sharedServerAccess: SharedServerAccessResolver;
  sessionSecret: string;
  plexClientId: string;
};

// Seerr's plex-recently-added-scan job runs every 5 minutes; 20 minutes is a
// small multiple that covers a couple of missed scans without treating a stale
// Seerr row as "still syncing".
const PLEX_SYNC_RECENCY_MS = 20 * 60 * 1000;

// Everything the browser needs to start playing one item without asking again.
// The `local` URLs are null when Plex advertises no LAN connection, so the
// player tries local first and falls back to remote.
type PlayDescriptor = {
  ratingKey: string;
  connections: Awaited<
    ReturnType<PlexConnectionResolver["resolveConnections"]>
  >;
  transient: string; // short-lived Plex token, deliberately sent in full
  hls: { local: string | null; remote: string }; // in-browser player
  dash: { local: string | null; remote: string }; // Chromecast receiver
  dashDecision: { local: string | null; remote: string }; // Cast handshake, see below
  sessionId: string; // the HLS transcode session, echoed for later control
  streams: { audio: AudioStream[]; subtitle: SubtitleStream[] };
  durationMs: number | null;
  creditsOffsetMs: number | null; // where the Up Next card fires, from Plex markers
  partId: string | null; // needed to select a subtitle track
  title: string | null;
  subheading: string | null;
  viewOffsetMs: number | null; // this user's resume position, null if unwatched
};

// Optional transcode tuning the player can pass as query params. Omitted keys
// aren't emitted into the Plex URL at all, so the untuned case stays identical
// to the fixed baseline.
type PlayTuning = {
  maxVideoBitrate?: number; // kbps
  videoResolution?: string; // "WxH", e.g. "1280x720"
  offset?: number; // seconds to start at
  audioStreamID?: string; // Plex stream id, from streams.audio
};

export function createWatchRouter(deps: WatchRouterDeps): Router {
  const {
    plexConnection,
    transientMinter,
    mediaStatus,
    plexServer,
    sharedServerAccess,
    sessionSecret,
    plexClientId,
  } = deps;
  const router = Router();

  // Shared users need their per-server Plex token against our PMS; the owner
  // isn't in that list, so fall back to the session's durable token.
  //
  // Getting this wrong once broke every shared account at the same time. A
  // shared user's general plex.tv token is not the token this server accepts.
  async function resolvePmsToken(
    plexId: number,
    durableToken: string,
  ): Promise<string> {
    const shared = await sharedServerAccess.resolveAccessToken(plexId);
    return shared ?? durableToken;
  }

  // Mints the caller's transient, resolves both connection URLs, and builds one
  // shared transcode session for a Plex ratingKey. Any mint/connection failure
  // throws (caught by the caller and turned into a 502) so we never emit a
  // partial descriptor.
  //
  // Three of the routes below are just param validation wrapped around this
  // function, which is where the actual playback work happens.
  async function buildPlayDescriptor(
    ratingKey: string,
    userToken: string,
    tuning: PlayTuning = {},
  ): Promise<PlayDescriptor> {
    // Fail before minting if the ratingKey has no metadata document.
    //
    // Passing userToken matters: metadata read as this user carries their
    // viewOffset, which is what the resume dialog runs on. Read as the owner it
    // would carry the owner's.
    const meta = await plexServer.playbackMeta(ratingKey, userToken);
    const transient = await transientMinter.mint(userToken);
    const connections = await plexConnection.resolveConnections();

    // One HLS transcode session shared across local/remote so the browser can
    // fall over without spawning a second session. DASH gets its own session
    // so Cast never fights the browser's HLS consumer for the same id.
    const sessionId = randomUUID();
    const dashSessionId = randomUUID();
    const sharedParams = {
      ratingKey,
      token: transient,
      clientId: plexClientId,
      ...tuning,
    };
    const hlsParams = { ...sharedParams, sessionId };
    const dashParams = { ...sharedParams, sessionId: dashSessionId };
    const hls = {
      remote: buildHlsUrl({
        connectionUri: connections.remote,
        ...hlsParams,
      }),
      local:
        connections.local === null
          ? null
          : buildHlsUrl({
              connectionUri: connections.local,
              ...hlsParams,
            }),
    };
    const dash = {
      remote: buildDashUrl({
        connectionUri: connections.remote,
        ...dashParams,
      }),
      local:
        connections.local === null
          ? null
          : buildDashUrl({
              connectionUri: connections.local,
              ...dashParams,
            }),
    };
    // Same DASH session id as dash{} — Plex requires /decision before start.mpd.
    const dashDecision = {
      remote: buildDashDecisionUrl({
        connectionUri: connections.remote,
        ...dashParams,
      }),
      local:
        connections.local === null
          ? null
          : buildDashDecisionUrl({
              connectionUri: connections.local,
              ...dashParams,
            }),
    };

    // The transient is returned IN FULL (unlike the masked admin probe): the
    // browser needs it to authenticate directly to Plex. Intended design.
    return {
      ratingKey,
      connections,
      transient,
      hls,
      dash,
      dashDecision,
      sessionId,
      streams: { audio: meta.audio, subtitle: meta.subtitle },
      durationMs: meta.durationMs,
      creditsOffsetMs: meta.creditsOffsetMs,
      partId: meta.partId,
      title: meta.title,
      subheading: meta.subheading,
      viewOffsetMs: meta.viewOffsetMs,
    };
  }

  /**
   * GET /api/watch/continue
   *
   * Plex's on-deck list for the signed-in user, as `{ items }`. This is the
   * Continue Watching rail. No params.
   *
   * 401 without a session, 502 if Plex fails. A session with no stored Plex
   * token gets an empty list rather than an error, because there's genuinely
   * nothing to show and the rail should just not render.
   */
  router.get("/continue", async (req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    let userToken: string | null;
    try {
      userToken = readPlexToken(session, sessionSecret);
    } catch (err) {
      respondUpstreamError(res, err);
      return;
    }
    if (userToken === null) {
      res.json({ items: [] });
      return;
    }

    try {
      const pmsToken = await resolvePmsToken(session.plexId, userToken);
      const items = await plexServer.onDeck(pmsToken);
      res.json({ items });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/watch/movie/:tmdbId
   *
   * The play descriptor for a movie the browser only knows by TMDB id, which is
   * the case coming off a title page. Optional tuning query params:
   * `maxVideoBitrate`, `videoResolution`, `offset`, `audioStreamID`.
   * Returns `{ mediaType: "movie", tmdbId, ...descriptor }`.
   *
   * 400 for a non-numeric tmdbId or bad tuning, 401 without a session,
   * 404 when Seerr has no Plex ratingKey for the title (it isn't on the server,
   * so it isn't playable), 409 when the session carries no Plex token and the
   * user has to log in again, 502 for any upstream failure.
   *
   * Library movies with no TMDB id can't come through here at all. That's what
   * /item/:ratingKey is for.
   */
  router.get("/movie/:tmdbId", async (req, res) => {
    const tmdbIdRaw = req.params.tmdbId;
    if (!/^\d+$/.test(tmdbIdRaw)) {
      res.status(400).json({ error: "tmdbId must be numeric" });
      return;
    }
    const tmdbId = Number(tmdbIdRaw);

    const tuningResult = parsePlayTuning(req.query);
    if (!tuningResult.ok) {
      res.status(400).json({ error: tuningResult.error });
      return;
    }

    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    let userToken: string | null;
    try {
      // readPlexToken throws on a tampered/corrupt blob; surface that as 502.
      userToken = readPlexToken(session, sessionSecret);
    } catch (err) {
      respondUpstreamError(res, err);
      return;
    }
    if (userToken === null) {
      res.status(409).json({ error: "re-login required" });
      return;
    }

    try {
      const pmsToken = await resolvePmsToken(session.plexId, userToken);

      // No Plex ratingKey means the title isn't available to stream (the
      // "Little House" case) — not playable.
      const ratingKey = await mediaStatus.getRatingKey("movie", tmdbId);
      if (ratingKey === null) {
        res.status(404).json({ error: "not playable" });
        return;
      }

      const descriptor = await buildPlayDescriptor(
        ratingKey,
        pmsToken,
        tuningResult.value,
      );
      res.json({ mediaType: "movie", tmdbId, ...descriptor });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/watch/tv/:tmdbId/episodes
   *
   * Flat episode list for a show, as `{ tmdbId, showRatingKey, episodes }`.
   * The browser holds onto those ratingKeys and plays them through
   * /episode/:ratingKey, which is why episodes are keyed on ratingKey and not
   * on season and episode numbers.
   *
   * 400 for a non-numeric tmdbId, 404 when Seerr has no show-level ratingKey,
   * 502 if Plex fails.
   *
   * This one doesn't read the session. It lists with the server token, so the
   * episode rows carry no per-user watch state.
   */
  router.get("/tv/:tmdbId/episodes", async (req, res) => {
    const tmdbIdRaw = req.params.tmdbId;
    if (!/^\d+$/.test(tmdbIdRaw)) {
      res.status(400).json({ error: "tmdbId must be numeric" });
      return;
    }
    const tmdbId = Number(tmdbIdRaw);

    try {
      // Some shows have no Seerr show-level ratingKey — a request-based
      // fallback is a later increment, so treat that as not playable for now.
      const showRatingKey = await mediaStatus.getRatingKey("tv", tmdbId);
      if (showRatingKey === null) {
        // Two 404 cases that used to look identical: Seerr may already know
        // the title (pending / processing / partially_available) and have
        // updated the row recently, which usually means Plex's library scan
        // hasn't caught up yet — a transient sync lag the Retry button can
        // clear. No row, an unusable timestamp, a stale update, or any other
        // status is a real dead end, so keep the existing "not playable".
        const row = await mediaStatus.getMediaRow("tv", tmdbId);
        const availability =
          row === null ? null : mediaStatusFromCode(row.status);
        const updatedAtMs =
          row?.updatedAt == null ? Number.NaN : Date.parse(row.updatedAt);
        const isRecent =
          Number.isFinite(updatedAtMs) &&
          Date.now() - updatedAtMs <= PLEX_SYNC_RECENCY_MS;
        const isSyncingStatus =
          availability === "pending" ||
          availability === "processing" ||
          availability === "partially_available";

        if (isSyncingStatus && isRecent) {
          res.status(404).json({
            error: "just added or updated — may still be syncing to Plex",
          });
          return;
        }

        res.status(404).json({ error: "not playable" });
        return;
      }

      const episodes = await plexServer.episodes(showRatingKey);
      res.json({ tmdbId, showRatingKey, episodes });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/watch/episode/:ratingKey/next
   *
   * `{ nextEpisode }`, the episode that follows this one in the same show, or
   * null at the end of a series. The Up Next overlay calls this while the
   * current episode is still playing so the card is ready before the credits.
   *
   * 400 for a non-numeric ratingKey, 502 if Plex fails. Reaching the last
   * episode is a 200 with null, not a 404.
   */
  router.get("/episode/:ratingKey/next", async (req, res) => {
    const ratingKey = req.params.ratingKey;
    if (!/^\d+$/.test(ratingKey)) {
      res.status(400).json({ error: "ratingKey must be numeric" });
      return;
    }

    try {
      const next = await plexServer.nextEpisode(ratingKey);
      res.json({ nextEpisode: next });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * POST /api/watch/timeline
   *
   * Reports one playback timeline event to Plex for the logged-in user so
   * resume position / watched state update on their account.
   *
   * Body: `ratingKey` (numeric string), `state` ("playing" | "paused" |
   * "stopped"), `time` and `duration` in milliseconds. Returns `{ ok: true }`.
   *
   * 400 for a malformed body, 401 without a session, 409 when the session has
   * no Plex token, 502 if Plex fails.
   *
   * The player calls this on a ticker, so it's the hot path for the whole
   * resume feature. It reports under the user's per-server token, which is what
   * makes watch state per-user instead of owner-wide, and it's why progress
   * from Tyflix shows up on the TV in the other room.
   */
  router.post("/timeline", async (req, res) => {
    const parsed = parseTimelineBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    let userToken: string | null;
    try {
      // readPlexToken throws on a tampered/corrupt blob; surface that as 502.
      userToken = readPlexToken(session, sessionSecret);
    } catch (err) {
      respondUpstreamError(res, err);
      return;
    }
    if (userToken === null) {
      res.status(409).json({ error: "re-login required" });
      return;
    }

    try {
      const pmsToken = await resolvePmsToken(session.plexId, userToken);
      await plexServer.reportTimeline({
        ratingKey: parsed.value.ratingKey,
        state: parsed.value.state,
        timeMs: parsed.value.time,
        durationMs: parsed.value.duration,
        userToken: pmsToken,
        clientId: plexClientId,
      });
      res.json({ ok: true });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * PUT /api/watch/subtitle/:ratingKey
   *
   * Selects (or clears) the burned-in subtitle for the current user on a media
   * item. The browser already has the ratingKey from a play descriptor; the
   * part id is resolved server-side so the client never has to guess it.
   *
   * Body: `subtitleStreamID`, a numeric string. "0" clears the selection.
   * Returns `{ ok: true }`.
   *
   * 400 for a bad ratingKey or subtitleStreamID, 401 without a session, 404
   * when the item has no part id, 409 when the session has no Plex token, 502
   * if Plex fails.
   *
   * Subtitles are burned into the transcode, and the URL parameter is not the
   * selector. The recipe that actually works is this PUT against the part
   * followed by restarting playback, which is why the client calls here and
   * then re-fetches a descriptor.
   */
  router.put("/subtitle/:ratingKey", async (req, res) => {
    const ratingKey = req.params.ratingKey;
    if (!/^\d+$/.test(ratingKey)) {
      res.status(400).json({ error: "ratingKey must be numeric" });
      return;
    }

    const subtitleStreamID = readSubtitleStreamID(req.body);
    if (subtitleStreamID === null) {
      res.status(400).json({ error: "subtitleStreamID must be numeric" });
      return;
    }

    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    let userToken: string | null;
    try {
      // readPlexToken throws on a tampered/corrupt blob; surface that as 502.
      userToken = readPlexToken(session, sessionSecret);
    } catch (err) {
      respondUpstreamError(res, err);
      return;
    }
    if (userToken === null) {
      res.status(409).json({ error: "re-login required" });
      return;
    }

    try {
      const pmsToken = await resolvePmsToken(session.plexId, userToken);

      // Read with the server token, not the user's. The part id is a property
      // of the file, so it's the same for everyone, and the selection below is
      // what gets applied per user.
      const meta = await plexServer.playbackMeta(ratingKey);
      if (meta.partId === null) {
        res.status(404).json({ error: "not playable" });
        return;
      }

      await plexServer.selectSubtitle(
        meta.partId,
        subtitleStreamID,
        pmsToken,
      );
      res.json({ ok: true });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/watch/episode/:ratingKey
   *
   * Play descriptor for one episode, returned as
   * `{ mediaType: "episode", ...descriptor }`. Takes the same optional tuning
   * query params as /movie/:tmdbId.
   *
   * 400 for a non-numeric ratingKey or bad tuning, 401 without a session, 409
   * when the session has no Plex token, 502 if Plex fails.
   *
   * This endpoint takes a RAW Plex episode ratingKey (the browser already has it
   * from GET /tv/:tmdbId/episodes) and is intentionally gated only by the user's
   * own Plex transient: Plex itself enforces what that account may stream, so we
   * deliberately do NOT re-check Seerr availability or ownership here.
   */
  router.get("/episode/:ratingKey", async (req, res) => {
    const ratingKey = req.params.ratingKey;
    // Plex ratingKeys are numeric strings.
    if (!/^\d+$/.test(ratingKey)) {
      res.status(400).json({ error: "ratingKey must be numeric" });
      return;
    }

    const tuningResult = parsePlayTuning(req.query);
    if (!tuningResult.ok) {
      res.status(400).json({ error: tuningResult.error });
      return;
    }

    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    let userToken: string | null;
    try {
      // readPlexToken throws on a tampered/corrupt blob; surface that as 502.
      userToken = readPlexToken(session, sessionSecret);
    } catch (err) {
      respondUpstreamError(res, err);
      return;
    }
    if (userToken === null) {
      res.status(409).json({ error: "re-login required" });
      return;
    }

    try {
      const pmsToken = await resolvePmsToken(session.plexId, userToken);

      const descriptor = await buildPlayDescriptor(
        ratingKey,
        pmsToken,
        tuningResult.value,
      );
      res.json({ mediaType: "episode", ...descriptor });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/watch/item/:ratingKey
   *
   * Play descriptor for any Plex item by raw ratingKey, returned with
   * `mediaType: "movie"`. Same optional tuning params as the other descriptor
   * routes, and the same status codes as /episode/:ratingKey: 400, 401, 409,
   * 502.
   *
   * This exists for library movies that have no tmdbId, which the tmdb-keyed
   * /movie/:tmdbId route can't resolve. Gated only by the user's own Plex
   * transient, like /episode/:ratingKey.
   */
  router.get("/item/:ratingKey", async (req, res) => {
    const ratingKey = req.params.ratingKey;
    if (!/^\d+$/.test(ratingKey)) {
      res.status(400).json({ error: "ratingKey must be numeric" });
      return;
    }

    const tuningResult = parsePlayTuning(req.query);
    if (!tuningResult.ok) {
      res.status(400).json({ error: tuningResult.error });
      return;
    }

    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    let userToken: string | null;
    try {
      userToken = readPlexToken(session, sessionSecret);
    } catch (err) {
      respondUpstreamError(res, err);
      return;
    }
    if (userToken === null) {
      res.status(409).json({ error: "re-login required" });
      return;
    }

    try {
      const pmsToken = await resolvePmsToken(session.plexId, userToken);

      const descriptor = await buildPlayDescriptor(
        ratingKey,
        pmsToken,
        tuningResult.value,
      );
      res.json({ mediaType: "movie", ...descriptor });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  return router;
}

// One progress report from the player, after validation.
type TimelineBody = {
  ratingKey: string;
  state: "playing" | "paused" | "stopped";
  time: number; // ms into the item
  duration: number; // ms total
};

// Validates a timeline POST. Strict on purpose, since a bad value here writes
// garbage into someone's Plex watch state. Note the non-object case reports the
// ratingKey error rather than a body error.
function parseTimelineBody(
  body: unknown,
): { ok: true; value: TimelineBody } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "ratingKey must be numeric" };
  }
  const raw = body as {
    ratingKey?: unknown;
    state?: unknown;
    time?: unknown;
    duration?: unknown;
  };

  if (typeof raw.ratingKey !== "string" || !/^\d+$/.test(raw.ratingKey)) {
    return { ok: false, error: "ratingKey must be numeric" };
  }

  if (
    raw.state !== "playing" &&
    raw.state !== "paused" &&
    raw.state !== "stopped"
  ) {
    return {
      ok: false,
      error: 'state must be "playing", "paused", or "stopped"',
    };
  }

  if (typeof raw.time !== "number" || !Number.isFinite(raw.time) || raw.time < 0) {
    return { ok: false, error: "time must be a finite number >= 0" };
  }

  if (
    typeof raw.duration !== "number" ||
    !Number.isFinite(raw.duration) ||
    raw.duration <= 0
  ) {
    return { ok: false, error: "duration must be a finite number > 0" };
  }

  return {
    ok: true,
    value: {
      ratingKey: raw.ratingKey,
      state: raw.state,
      time: raw.time,
      duration: raw.duration,
    },
  };
}

// "0" is valid (clear selection). Non-string / non-numeric → null.
function readSubtitleStreamID(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const raw = (body as { subtitleStreamID?: unknown }).subtitleStreamID;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return null;
  }
  return raw;
}

// Validates the optional transcode-tuning query params. Absent keys stay absent
// in the result, which is what keeps an untuned URL byte-identical to the
// baseline. The same rules are enforced again in transcodeUrl.ts, but doing it
// here means a typo comes back as a 400 instead of a 502.
function parsePlayTuning(
  query: Record<string, unknown>,
): { ok: true; value: PlayTuning } | { ok: false; error: string } {
  const tuning: PlayTuning = {};

  if (query.maxVideoBitrate !== undefined) {
    const raw = firstQueryValue(query.maxVideoBitrate);
    if (raw === undefined) {
      return {
        ok: false,
        error: "maxVideoBitrate must be a positive integer",
      };
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return {
        ok: false,
        error: "maxVideoBitrate must be a positive integer",
      };
    }
    tuning.maxVideoBitrate = n;
  }

  if (query.videoResolution !== undefined) {
    const raw = firstQueryValue(query.videoResolution);
    if (raw === undefined || !/^\d+x\d+$/.test(raw)) {
      return {
        ok: false,
        error: 'videoResolution must match "WxH" (e.g. "1280x720")',
      };
    }
    tuning.videoResolution = raw;
  }

  if (query.offset !== undefined) {
    const raw = firstQueryValue(query.offset);
    if (raw === undefined) {
      return { ok: false, error: "offset must be a finite number >= 0" };
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: "offset must be a finite number >= 0" };
    }
    tuning.offset = n;
  }

  if (query.audioStreamID !== undefined) {
    const raw = firstQueryValue(query.audioStreamID);
    if (raw === undefined || raw.trim() === "") {
      return {
        ok: false,
        error: "audioStreamID must be a non-empty string",
      };
    }
    tuning.audioStreamID = raw;
  }

  return { ok: true, value: tuning };
}

// Express hands back an array when a query key repeats, so take the first and
// coerce the primitive cases to string. Undefined means "nothing usable here".
function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    value = value[0];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

// Every failure path in this router ends here as a 502, including a
// TokenDecryptError from a tampered cookie. Playback has a lot of moving parts
// (mint, connection resolve, metadata) and none of them get their own status
// code; the message is the only thing that distinguishes them.
function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof PlexConnectionError || err instanceof PlexTransientError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
