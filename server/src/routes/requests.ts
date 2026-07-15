import { Router } from "express";
import { requireAdmin } from "../middleware/auth";
import {
  SeerrUpstreamError,
  toRequestView,
  type RequestView,
  type SeerrClient,
  type SeerrRequest,
} from "../seerr/client";
import type { SessionPayload } from "../session";
import type { TmdbClient } from "../tmdb/client";

export type RequestsRouterDeps = {
  seerr: Pick<
    SeerrClient,
    | "listAllRequests"
    | "listUserRequests"
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

    try {
      const request = await seerr.createRequest({
        mediaType: parsed.mediaType,
        tmdbId: parsed.tmdbId,
        ...(parsed.mediaType === "tv" && parsed.seasons !== undefined
          ? { seasons: parsed.seasons }
          : {}),
        userId: session.seerrUserId,
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

async function enrichRequests(
  requests: SeerrRequest[],
  tmdb: Pick<TmdbClient, "movieDetail" | "tvDetail">,
): Promise<RequestView[]> {
  const titles = new Map<number, Promise<string>>();
  return Promise.all(
    requests.map((request) => enrichRequest(request, tmdb, titles)),
  );
}

async function enrichRequest(
  request: SeerrRequest,
  tmdb: Pick<TmdbClient, "movieDetail" | "tvDetail">,
  titles: Map<number, Promise<string>>,
): Promise<RequestView> {
  let title = titles.get(request.media.tmdbId);
  if (title === undefined) {
    title =
      request.type === "movie"
        ? tmdb.movieDetail(request.media.tmdbId).then((detail) => detail.title)
        : tmdb.tvDetail(request.media.tmdbId).then((detail) => detail.title);
    titles.set(request.media.tmdbId, title);
  }
  return toRequestView(request, await title);
}

function parseCreateBody(
  body: unknown,
):
  | { error: string }
  | {
      tmdbId: number;
      mediaType: "movie";
    }
  | {
      tmdbId: number;
      mediaType: "tv";
      seasons?: number[];
    } {
  if (typeof body !== "object" || body === null) {
    return { error: "invalid body" };
  }

  const tmdbId = (body as { tmdbId?: unknown }).tmdbId;
  const mediaType = (body as { mediaType?: unknown }).mediaType;
  const seasons = (body as { seasons?: unknown }).seasons;

  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId < 1) {
    return { error: "tmdbId must be a positive integer" };
  }
  if (mediaType !== "movie" && mediaType !== "tv") {
    return { error: "mediaType must be movie or tv" };
  }

  if (mediaType === "tv") {
    if (seasons === undefined) {
      return { tmdbId, mediaType };
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
    return { tmdbId, mediaType, seasons };
  }

  return { tmdbId, mediaType };
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
