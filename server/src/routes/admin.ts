import { randomUUID } from "node:crypto";
import { Router } from "express";
import {
  DashboardUpstreamError,
  type DashboardClient,
} from "../dashboard/client";
import {
  PlexConnectionError,
  type PlexConnectionResolver,
} from "../plex/connection";
import { buildHlsDecisionUrl, buildHlsUrl } from "../plex/transcodeUrl";
import {
  PlexTransientError,
  type TransientTokenMinter,
} from "../plex/transientToken";
import type { MediaStatusProvider } from "../seerr/mediaStatusProvider";
import { readPlexToken, type SessionPayload } from "../session";

export type AdminRouterDeps = {
  dashboard: DashboardClient;
  plexConnection: PlexConnectionResolver;
  transientMinter: TransientTokenMinter;
  sessionSecret: string;
  plexBaseUrl: string;
  plexClientId: string;
  mediaStatus: MediaStatusProvider;
};

const PROXY_PATHS = ["system", "users", "jobs", "containers"] as const;

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const {
    dashboard,
    plexConnection,
    transientMinter,
    sessionSecret,
    plexBaseUrl,
    plexClientId,
    mediaStatus,
  } = deps;
  const router = Router();

  for (const name of PROXY_PATHS) {
    router.get(`/${name}`, async (_req, res) => {
      try {
        const body = await dashboard.getJson(`/api/${name}`);
        res.json(body);
      } catch (err) {
        respondUpstreamError(res, err);
      }
    });
  }

  // TEMPORARY probe: returns our server's direct external plex.direct base URL
  // so the upcoming play-decision endpoint can be built against a real address.
  // Admin-gated (requireAdmin at mount time). REMOVE once the /api/watch
  // play-decision endpoint lands.
  router.get("/plex-connection", async (_req, res) => {
    try {
      const { local, remote } = await plexConnection.resolveConnections();
      res.json({ local, remote });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  // TEMPORARY probe: recovers the admin's own durable Plex token, mints a
  // short-lived transient from it, and verifies the transient authenticates
  // against our Plex server. Verification hits the LAN base URL (which the
  // backend can always reach) rather than the external plex.direct URL — NAT
  // hairpin means the server can't reach its own public IP, which produced a
  // false negative. directUri is still returned for info. Confirms the
  // 15.1/15.2/15.3 chain end to end. Admin-gated (requireAdmin at mount time).
  // The full transient token is never returned. REMOVE once the /api/watch
  // play-decision endpoint lands.
  router.get("/plex-transient", async (_req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (session === undefined) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    let userToken: string | null;
    try {
      // readPlexToken throws on a tampered/corrupt blob; let that surface as 502.
      userToken = readPlexToken(session, sessionSecret);
    } catch (err) {
      respondUpstreamError(res, err);
      return;
    }

    if (userToken === null) {
      res
        .status(409)
        .json({ error: "no stored Plex token; re-login required" });
      return;
    }

    try {
      const transient = await transientMinter.mint(userToken);
      const { remote: directUri } = await plexConnection.resolveConnections();
      const authenticatesAgainstServer = await verifyAgainstServer(
        plexBaseUrl,
        transient,
      );

      res.json({
        ok: true,
        tokenLength: transient.length,
        tokenPreview: maskToken(transient),
        authenticatesAgainstServer,
        directUri,
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  // TEMPORARY probe: returns the Plex ratingKey Seerr tracks for a title so we
  // can confirm Seerr surfaces a real ratingKey for a known-available title.
  // Admin-gated (requireAdmin at mount time). REMOVE once the /api/watch
  // play-decision endpoint lands.
  router.get("/plex-ratingkey", async (req, res) => {
    const typeRaw = req.query.type;
    const tmdbIdRaw = req.query.tmdbId;

    if (typeRaw !== "movie" && typeRaw !== "tv") {
      res.status(400).json({ error: "type must be 'movie' or 'tv'" });
      return;
    }
    if (typeof tmdbIdRaw !== "string" || !/^\d+$/.test(tmdbIdRaw)) {
      res.status(400).json({ error: "tmdbId must be a numeric query param" });
      return;
    }

    const tmdbId = Number(tmdbIdRaw);

    try {
      const status =
        (await mediaStatus.getStatusMap()).get(`${typeRaw}:${tmdbId}`) ?? null;
      const ratingKey = await mediaStatus.getRatingKey(typeRaw, tmdbId);
      res.json({ tmdbId, mediaType: typeRaw, status, ratingKey });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  // TEMPORARY probe: reports Plex's transcode DECISION for a title so we can
  // confirm the built URL will produce browser-safe (H.264) video rather than
  // direct-playing/stream-copying HEVC. Resolves the ratingKey, recovers the
  // admin's durable token, mints a transient, and hits /video/:/transcode/
  // universal/decision against the LOCAL connection URI (the backend can reach
  // the LAN, not the external plex.direct IP via NAT hairpin). The /decision
  // endpoint does NOT start a transcode; fetching start.m3u8 would. The full
  // token is never returned (urlPreview masks it). Admin-gated (requireAdmin at
  // mount time). REMOVE once HLS is integrated into the /api/watch descriptor.
  router.get("/plex-transcode", async (req, res) => {
    const typeRaw = req.query.type;
    const tmdbIdRaw = req.query.tmdbId;

    if (typeRaw !== "movie" && typeRaw !== "tv") {
      res.status(400).json({ error: "type must be 'movie' or 'tv'" });
      return;
    }
    if (typeof tmdbIdRaw !== "string" || !/^\d+$/.test(tmdbIdRaw)) {
      res.status(400).json({ error: "tmdbId must be a numeric query param" });
      return;
    }

    const tmdbId = Number(tmdbIdRaw);

    let ratingKey: string | null;
    try {
      ratingKey = await mediaStatus.getRatingKey(typeRaw, tmdbId);
    } catch (err) {
      respondUpstreamError(res, err);
      return;
    }
    if (ratingKey === null) {
      res.status(404).json({ error: "not playable" });
      return;
    }

    const session = res.locals.session as SessionPayload | undefined;
    if (session === undefined) {
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
      res
        .status(409)
        .json({ error: "no stored Plex token; re-login required" });
      return;
    }

    let transient: string;
    let connectionUri: string;
    try {
      transient = await transientMinter.mint(userToken);
      const { local, remote } = await plexConnection.resolveConnections();
      // Prefer the LAN connection — the backend can't reach the external IP.
      connectionUri = local ?? remote;
    } catch (err) {
      respondUpstreamError(res, err);
      return;
    }

    const sessionId = randomUUID();
    const urlParams = {
      connectionUri,
      ratingKey,
      token: transient,
      clientId: plexClientId,
      sessionId,
    };
    const decisionUrl = buildHlsDecisionUrl(urlParams);
    const startUrl = buildHlsUrl(urlParams);

    // A failed decision fetch surfaces as { ok: false } (NOT a thrown 502) so we
    // can inspect what went wrong.
    let ok = false;
    let httpStatus = 0;
    let decisionSnippet: string;
    let decisionBody = "";
    try {
      const decisionRes = await fetch(decisionUrl, {
        headers: { Accept: "application/json" },
      });
      ok = decisionRes.ok;
      httpStatus = decisionRes.status;
      decisionBody = await decisionRes.text();
      decisionSnippet = decisionBody.slice(0, 1500);
    } catch (err) {
      decisionSnippet =
        err instanceof Error ? err.message : "decision fetch failed";
    }

    // Per-stream summary so we can see whether the video is TRANSCODEd to H.264
    // or merely COPYied (a copied HEVC stream is unplayable in a browser). Parsed
    // defensively — any missing level yields null so the caller falls back to
    // decisionSnippet.
    const decisionSummary = parseDecisionStreams(decisionBody);

    res.json({
      ok,
      httpStatus,
      decisionSnippet,
      streams: decisionSummary.streams,
      mediaVideoCodec: decisionSummary.mediaVideoCodec,
      mediaAudioCodec: decisionSummary.mediaAudioCodec,
      urlPreview: startUrl.split(transient).join(maskToken(transient)),
    });
  });

  return router;
}

// Confirms a transient token works against an AUTH-REQUIRED endpoint on the LAN
// base URL. /library/sections requires a token (unlike /identity), so a 200 is
// a genuine positive. We use the LAN URL because the backend can always reach
// it (the external plex.direct URL is unreachable from inside the LAN via NAT
// hairpin). A failure is reported as false rather than thrown so the probe can
// surface it.
async function verifyAgainstServer(
  baseUrl: string,
  transient: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/library/sections`, {
      method: "GET",
      headers: {
        "X-Plex-Token": transient,
        Accept: "application/json",
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

type DecisionStream = {
  streamType: number | null;
  codec: string | null;
  decision: string | null;
};

type DecisionSummary = {
  // null when the expected shape is missing — fall back to decisionSnippet.
  streams: DecisionStream[] | null;
  mediaVideoCodec: string | null;
  mediaAudioCodec: string | null;
};

// Defensively parses Plex's /decision JSON to a compact per-stream summary.
// Expected shape: MediaContainer.Metadata[0].Media[0].Part[0].Stream[], where
// each Stream has decision ("transcode" | "copy"), codec, and streamType
// (1 = video, 2 = audio). Any missing/odd level returns streams: null rather
// than throwing.
function parseDecisionStreams(body: string): DecisionSummary {
  const empty: DecisionSummary = {
    streams: null,
    mediaVideoCodec: null,
    mediaAudioCodec: null,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return empty;
  }

  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  const firstOf = (value: unknown): unknown =>
    Array.isArray(value) ? value[0] : undefined;
  const asString = (value: unknown): string | null =>
    typeof value === "string" ? value : null;
  const asNumber = (value: unknown): number | null =>
    typeof value === "number" ? value : null;

  const container = record(record(parsed)?.MediaContainer);
  const metadata = record(firstOf(container?.Metadata));
  const media = record(firstOf(metadata?.Media));
  const part = record(firstOf(media?.Part));
  const rawStreams = part?.Stream;

  if (media === null) {
    return empty;
  }

  const mediaVideoCodec = asString(media.videoCodec);
  const mediaAudioCodec = asString(media.audioCodec);

  if (!Array.isArray(rawStreams)) {
    return { streams: null, mediaVideoCodec, mediaAudioCodec };
  }

  const streams: DecisionStream[] = rawStreams.map((raw) => {
    const stream = record(raw);
    return {
      streamType: asNumber(stream?.streamType),
      codec: asString(stream?.codec),
      decision: asString(stream?.decision),
    };
  });

  return { streams, mediaVideoCodec, mediaAudioCodec };
}

// Masks all but the first 6 / last 4 characters so the probe never leaks a
// usable token.
function maskToken(token: string): string {
  if (token.length <= 10) {
    return "*".repeat(token.length);
  }
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof DashboardUpstreamError ||
    err instanceof PlexConnectionError ||
    err instanceof PlexTransientError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
