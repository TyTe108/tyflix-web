import { Router } from "express";
import {
  createRequest,
  findActiveDuplicate,
  getRequestById,
  listAllRequests,
  listRequestsByUser,
  updateRequest,
  type MediaType,
  type RequestRow,
} from "../db/requests";
import { requireAdmin } from "../middleware/auth";
import type { RadarrClient } from "../radarr/client";
import { RadarrUpstreamError } from "../radarr/client";
import { shouldAutoApprove } from "../requests/autoApprove";
import {
  processMedia,
  type ProcessMediaConfig,
} from "../requests/processMedia";
import type { SessionPayload } from "../session";
import type { SonarrClient } from "../sonarr/client";
import { SonarrUpstreamError } from "../sonarr/client";
import type { TmdbClient } from "../tmdb/client";
import { TmdbUpstreamError } from "../tmdb/client";

export type RequestsRouterDeps = {
  tmdb: TmdbClient;
  radarr: RadarrClient;
  sonarr: SonarrClient;
  config: ProcessMediaConfig;
  sessionSecret: string;
};

export function createRequestsRouter(deps: RequestsRouterDeps): Router {
  const { tmdb, radarr, sonarr, config, sessionSecret } = deps;
  const processDeps = { tmdb, radarr, sonarr, config };
  const router = Router();
  const admin = requireAdmin(sessionSecret);

  router.post("/", async (req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    const parsed = parseCreateBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { tmdbId, mediaType, seasons } = parsed;

    const duplicate = findActiveDuplicate(tmdbId, mediaType);
    if (duplicate !== null) {
      res.status(409).json({ error: "already requested", request: duplicate });
      return;
    }

    let title: string;
    try {
      if (mediaType === "movie") {
        const detail = await tmdb.movieDetail(tmdbId);
        title = detail.title;
      } else {
        const detail = await tmdb.tvDetail(tmdbId);
        title = detail.title;
      }
    } catch (err) {
      respondUpstreamError(res, err);
      return;
    }

    const auto = shouldAutoApprove(session.permissions, mediaType);
    let row = createRequest({
      tmdbId,
      mediaType,
      title,
      seasons: mediaType === "tv" ? seasons : null,
      requestedBySeerrId: session.seerrUserId,
      requestedByName: session.displayName,
      requestStatus: auto ? "approved" : "pending",
      mediaStatus: "unknown",
    });

    if (auto) {
      const decidedAt = new Date().toISOString();
      row = updateRequest(row.id, {
        decidedBy: session.seerrUserId,
        decidedAt,
      });

      try {
        const result = await processMedia(row, processDeps);
        row = updateRequest(row.id, {
          mediaStatus: result.mediaStatus,
          ...(result.radarrId !== undefined ? { radarrId: result.radarrId } : {}),
          ...(result.sonarrId !== undefined ? { sonarrId: result.sonarrId } : {}),
        });
      } catch (err) {
        updateRequest(row.id, { requestStatus: "failed" });
        respondUpstreamError(res, err);
        return;
      }
    }

    res.status(201).json(row);
  });

  router.get("/", (_req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    res.json({ results: listRequestsByUser(session.seerrUserId) });
  });

  router.get("/all", admin, (_req, res) => {
    res.json({ results: listAllRequests() });
  });

  router.post("/:id/approve", admin, async (req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    const id = parseNumericId(
      typeof req.params.id === "string" ? req.params.id : undefined,
    );
    if (id === null) {
      res.status(400).json({ error: "invalid request id" });
      return;
    }

    const existing = getRequestById(id);
    if (existing === null) {
      res.status(404).json({ error: "request not found" });
      return;
    }
    if (existing.requestStatus !== "pending") {
      res.status(409).json({ error: "request is not pending" });
      return;
    }

    const decidedAt = new Date().toISOString();
    let row = updateRequest(id, {
      requestStatus: "approved",
      decidedBy: session.seerrUserId,
      decidedAt,
    });

    try {
      const result = await processMedia(row, processDeps);
      row = updateRequest(row.id, {
        mediaStatus: result.mediaStatus,
        ...(result.radarrId !== undefined ? { radarrId: result.radarrId } : {}),
        ...(result.sonarrId !== undefined ? { sonarrId: result.sonarrId } : {}),
      });
    } catch (err) {
      updateRequest(row.id, { requestStatus: "failed" });
      respondUpstreamError(res, err);
      return;
    }

    res.json(row);
  });

  router.post("/:id/decline", admin, (req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    const id = parseNumericId(
      typeof req.params.id === "string" ? req.params.id : undefined,
    );
    if (id === null) {
      res.status(400).json({ error: "invalid request id" });
      return;
    }

    const existing = getRequestById(id);
    if (existing === null) {
      res.status(404).json({ error: "request not found" });
      return;
    }
    if (existing.requestStatus !== "pending") {
      res.status(409).json({ error: "request is not pending" });
      return;
    }

    const row = updateRequest(id, {
      requestStatus: "declined",
      decidedBy: session.seerrUserId,
      decidedAt: new Date().toISOString(),
    });
    res.json(row);
  });

  return router;
}

function parseCreateBody(
  body: unknown,
):
  | { error: string }
  | { tmdbId: number; mediaType: MediaType; seasons: number[] | null } {
  if (typeof body !== "object" || body === null) {
    return { error: "invalid body" };
  }

  const tmdbIdRaw = (body as { tmdbId?: unknown }).tmdbId;
  const mediaTypeRaw = (body as { mediaType?: unknown }).mediaType;
  const seasonsRaw = (body as { seasons?: unknown }).seasons;

  if (typeof tmdbIdRaw !== "number" || !Number.isInteger(tmdbIdRaw) || tmdbIdRaw < 1) {
    return { error: "tmdbId must be a positive integer" };
  }
  if (mediaTypeRaw !== "movie" && mediaTypeRaw !== "tv") {
    return { error: "mediaType must be movie or tv" };
  }

  if (mediaTypeRaw === "tv") {
    if (!Array.isArray(seasonsRaw) || seasonsRaw.length === 0) {
      return { error: "seasons is required for tv requests" };
    }
    for (const season of seasonsRaw) {
      if (typeof season !== "number" || !Number.isInteger(season) || season < 1) {
        return { error: "seasons must be positive integers" };
      }
    }
    return { tmdbId: tmdbIdRaw, mediaType: "tv", seasons: seasonsRaw };
  }

  return { tmdbId: tmdbIdRaw, mediaType: "movie", seasons: null };
}

function parseNumericId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof TmdbUpstreamError ||
    err instanceof RadarrUpstreamError ||
    err instanceof SonarrUpstreamError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}

export type { RequestRow };
