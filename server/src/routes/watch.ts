import { randomUUID } from "node:crypto";
import { Router } from "express";
import {
  PlexConnectionError,
  type PlexConnectionResolver,
} from "../plex/connection";
import { buildHlsUrl } from "../plex/transcodeUrl";
import {
  PlexTransientError,
  type TransientTokenMinter,
} from "../plex/transientToken";
import type { PlexServerClient } from "../plex/server";
import type { MediaStatusProvider } from "../seerr/mediaStatusProvider";
import { readPlexToken, type SessionPayload } from "../session";

export type WatchRouterDeps = {
  plexConnection: PlexConnectionResolver;
  transientMinter: TransientTokenMinter;
  mediaStatus: MediaStatusProvider;
  plexServer: PlexServerClient;
  sessionSecret: string;
  plexClientId: string;
};

export function createWatchRouter(deps: WatchRouterDeps): Router {
  const {
    plexConnection,
    transientMinter,
    mediaStatus,
    plexServer,
    sessionSecret,
    plexClientId,
  } = deps;
  const router = Router();

  router.get("/movie/:tmdbId", async (req, res) => {
    const tmdbIdRaw = req.params.tmdbId;
    if (!/^\d+$/.test(tmdbIdRaw)) {
      res.status(400).json({ error: "tmdbId must be numeric" });
      return;
    }
    const tmdbId = Number(tmdbIdRaw);

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
      // No Plex ratingKey means the title isn't available to stream (the
      // "Little House" case) — not playable.
      const ratingKey = await mediaStatus.getRatingKey("movie", tmdbId);
      if (ratingKey === null) {
        res.status(404).json({ error: "not playable" });
        return;
      }

      const transient = await transientMinter.mint(userToken);
      const connections = await plexConnection.resolveConnections();

      // One transcode session shared across both connection URLs so the client
      // can switch between local/remote without spawning a second transcode.
      const sessionId = randomUUID();
      const hls = {
        remote: buildHlsUrl({
          connectionUri: connections.remote,
          ratingKey,
          token: transient,
          clientId: plexClientId,
          sessionId,
        }),
        local:
          connections.local === null
            ? null
            : buildHlsUrl({
                connectionUri: connections.local,
                ratingKey,
                token: transient,
                clientId: plexClientId,
                sessionId,
              }),
      };

      // The transient is returned IN FULL (unlike the masked admin probe): the
      // browser needs it to authenticate directly to Plex. Intended design.
      res.json({
        mediaType: "movie",
        tmdbId,
        ratingKey,
        connections,
        transient,
        hls,
        sessionId,
      });
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

  return router;
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
