import { randomUUID } from "node:crypto";
import { Router } from "express";
import {
  PlexConnectionError,
  type PlexConnectionResolver,
} from "../plex/connection";
import type { SharedServerAccessResolver } from "../plex/sharedServerAccess";
import { buildHlsUrl } from "../plex/transcodeUrl";
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

type PlayDescriptor = {
  ratingKey: string;
  connections: Awaited<
    ReturnType<PlexConnectionResolver["resolveConnections"]>
  >;
  transient: string;
  hls: { local: string | null; remote: string };
  sessionId: string;
  streams: { audio: AudioStream[]; subtitle: SubtitleStream[] };
  durationMs: number | null;
  creditsOffsetMs: number | null;
  partId: string | null;
  title: string | null;
  subheading: string | null;
};

type PlayTuning = {
  maxVideoBitrate?: number;
  videoResolution?: string;
  offset?: number;
  audioStreamID?: string;
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
  async function buildPlayDescriptor(
    ratingKey: string,
    userToken: string,
    tuning: PlayTuning = {},
  ): Promise<PlayDescriptor> {
    // Fail before minting if the ratingKey has no metadata document.
    const meta = await plexServer.playbackMeta(ratingKey);
    const transient = await transientMinter.mint(userToken);
    const connections = await plexConnection.resolveConnections();

    // One transcode session shared across both connection URLs so the client
    // can switch between local/remote without spawning a second transcode.
    const sessionId = randomUUID();
    const hlsParams = {
      ratingKey,
      token: transient,
      clientId: plexClientId,
      sessionId,
      ...tuning,
    };
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

    // The transient is returned IN FULL (unlike the masked admin probe): the
    // browser needs it to authenticate directly to Plex. Intended design.
    return {
      ratingKey,
      connections,
      transient,
      hls,
      sessionId,
      streams: { audio: meta.audio, subtitle: meta.subtitle },
      durationMs: meta.durationMs,
      creditsOffsetMs: meta.creditsOffsetMs,
      partId: meta.partId,
      title: meta.title,
      subheading: meta.subheading,
    };
  }

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
        res.status(404).json({ error: "not playable" });
        return;
      }

      const episodes = await plexServer.episodes(showRatingKey);
      res.json({ tmdbId, showRatingKey, episodes });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

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

  // Selects (or clears) the burned-in subtitle for the current user on a media
  // item. The browser already has the ratingKey from a play descriptor; the
  // part id is resolved server-side so the client never has to guess it.
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

  // This endpoint takes a RAW Plex episode ratingKey (the browser already has it
  // from GET /tv/:tmdbId/episodes) and is intentionally gated only by the user's
  // own Plex transient: Plex itself enforces what that account may stream, so we
  // deliberately do NOT re-check Seerr availability or ownership here.
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

  // Plays any Plex item by raw ratingKey — used for library movies that have no
  // tmdbId (so the tmdb-keyed /movie/:tmdbId route can't resolve them). Gated
  // only by the user's own Plex transient, like /episode/:ratingKey.
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
