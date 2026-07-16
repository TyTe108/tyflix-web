import { Router } from "express";
import { requireAdmin } from "../middleware/auth";
import {
  SeerrUpstreamError,
  toRequestView,
  type RequestView,
  type SeerrClient,
  type SeerrRequest,
} from "../seerr/client";
import { isAdmin, type SessionPayload } from "../session";
import type { TmdbClient } from "../tmdb/client";

export type RequestsRouterDeps = {
  seerr: Pick<
    SeerrClient,
    | "listAllRequests"
    | "listUserRequests"
    | "getServiceProfiles"
    | "createRequest"
    | "approveRequest"
    | "declineRequest"
  >;
  tmdb: Pick<TmdbClient, "movieDetail" | "tvDetail">;
  sessionSecret: string;
};

export function createRequestsRouter(deps: RequestsRouterDeps): Router {
  const { seerr, tmdb, sessionSecret } = deps;
  const router = Router();
  const admin = requireAdmin(sessionSecret);

  router.get("/profiles", admin, async (req, res) => {
    const mediaType =
      typeof req.query.mediaType === "string" ? req.query.mediaType : undefined;
    if (mediaType !== "movie" && mediaType !== "tv") {
      res.status(400).json({ error: "mediaType must be movie or tv" });
      return;
    }

    try {
      res.json(await seerr.getServiceProfiles(mediaType));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

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

    if (
      parsed.profileId !== undefined &&
      !isAdmin(session.permissions)
    ) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    try {
      const profileOverride =
        parsed.profileId === undefined
          ? {}
          : {
              profileId: parsed.profileId,
              serverId: (
                await seerr.getServiceProfiles(parsed.mediaType)
              ).serverId,
            };
      const request = await seerr.createRequest({
        mediaType: parsed.mediaType,
        tmdbId: parsed.tmdbId,
        ...(parsed.mediaType === "tv" && parsed.seasons !== undefined
          ? { seasons: parsed.seasons }
          : {}),
        userId: session.seerrUserId,
        ...profileOverride,
      });
      const view = await enrichRequest(request, tmdb, new Map());
      res.status(201).json(view);
    } catch (err) {
      if (err instanceof SeerrUpstreamError && err.status === 409) {
        res.status(409).json({ error: "already requested" });
        return;
      }
      respondUpstreamError(res, err);
    }
  });

  router.get("/", async (_req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    try {
      const requests = await seerr.listUserRequests(session.seerrUserId);
      res.json({ results: await enrichRequests(requests, tmdb) });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/all", admin, async (_req, res) => {
    try {
      const requests = await seerr.listAllRequests();
      res.json({ results: await enrichRequests(requests, tmdb) });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.post("/:id/approve", admin, async (req, res) => {
    const id = parseNumericId(
      typeof req.params.id === "string" ? req.params.id : undefined,
    );
    if (id === null) {
      res.status(400).json({ error: "invalid request id" });
      return;
    }

    try {
      const request = await seerr.approveRequest(id);
      res.json(await enrichRequest(request, tmdb, new Map()));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.post("/:id/decline", admin, async (req, res) => {
    const id = parseNumericId(
      typeof req.params.id === "string" ? req.params.id : undefined,
    );
    if (id === null) {
      res.status(400).json({ error: "invalid request id" });
      return;
    }

    try {
      const request = await seerr.declineRequest(id);
      res.json(await enrichRequest(request, tmdb, new Map()));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  return router;
}

type RequestDetail = { title: string; posterUrl: string | null };

async function enrichRequests(
  requests: SeerrRequest[],
  tmdb: Pick<TmdbClient, "movieDetail" | "tvDetail">,
): Promise<RequestView[]> {
  const details = new Map<number, Promise<RequestDetail>>();
  return Promise.all(
    requests.map((request) => enrichRequest(request, tmdb, details)),
  );
}

async function enrichRequest(
  request: SeerrRequest,
  tmdb: Pick<TmdbClient, "movieDetail" | "tvDetail">,
  details: Map<number, Promise<RequestDetail>>,
): Promise<RequestView> {
  let detail = details.get(request.media.tmdbId);
  if (detail === undefined) {
    detail =
      request.type === "movie"
        ? tmdb.movieDetail(request.media.tmdbId).then((movie) => ({
            title: movie.title,
            posterUrl: movie.posterUrl,
          }))
        : tmdb.tvDetail(request.media.tmdbId).then((tv) => ({
            title: tv.title,
            posterUrl: tv.posterUrl,
          }));
    details.set(request.media.tmdbId, detail);
  }
  return toRequestView(request, await detail);
}

function parseCreateBody(
  body: unknown,
):
  | { error: string }
  | {
      tmdbId: number;
      mediaType: "movie";
      profileId?: number;
    }
  | {
      tmdbId: number;
      mediaType: "tv";
      seasons?: number[];
      profileId?: number;
    } {
  if (typeof body !== "object" || body === null) {
    return { error: "invalid body" };
  }

  const tmdbId = (body as { tmdbId?: unknown }).tmdbId;
  const mediaType = (body as { mediaType?: unknown }).mediaType;
  const seasons = (body as { seasons?: unknown }).seasons;
  const profileId = (body as { profileId?: unknown }).profileId;

  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId < 1) {
    return { error: "tmdbId must be a positive integer" };
  }
  if (mediaType !== "movie" && mediaType !== "tv") {
    return { error: "mediaType must be movie or tv" };
  }
  if (
    profileId !== undefined &&
    (typeof profileId !== "number" ||
      !Number.isInteger(profileId) ||
      profileId < 1)
  ) {
    return { error: "profileId must be a positive integer" };
  }

  if (mediaType === "tv") {
    if (seasons === undefined) {
      return {
        tmdbId,
        mediaType,
        ...(profileId === undefined ? {} : { profileId }),
      };
    }
    if (!Array.isArray(seasons)) {
      return { error: "seasons must be an array" };
    }
    if (
      seasons.some(
        (season) =>
          typeof season !== "number" ||
          !Number.isInteger(season) ||
          season < 1,
      )
    ) {
      return { error: "seasons must be positive integers" };
    }
    return {
      tmdbId,
      mediaType,
      seasons,
      ...(profileId === undefined ? {} : { profileId }),
    };
  }

  return {
    tmdbId,
    mediaType,
    ...(profileId === undefined ? {} : { profileId }),
  };
}

function parseNumericId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof Error ? err.message : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
