import { Router } from "express";
import {
  mediaStatusFromCode,
  type MediaAvailability,
  type SeerrClient,
} from "../seerr/client";
import { TmdbUpstreamError, type TmdbClient } from "../tmdb/client";

export type DiscoverRouterDeps = {
  tmdb: TmdbClient;
  seerr: Pick<SeerrClient, "listMedia">;
};

export function createDiscoverRouter(deps: DiscoverRouterDeps): Router {
  const { tmdb, seerr } = deps;
  const router = Router();
  let mediaStatusCache:
    | { expiresAt: number; statuses: Map<string, MediaAvailability> }
    | undefined;

  async function getMediaStatuses(): Promise<Map<string, MediaAvailability>> {
    if (mediaStatusCache !== undefined && mediaStatusCache.expiresAt > Date.now()) {
      return mediaStatusCache.statuses;
    }

    try {
      const media = await seerr.listMedia();
      const statuses = new Map<string, MediaAvailability>();
      for (const item of media) {
        const status = mediaStatusFromCode(item.status);
        if (status !== null) {
          statuses.set(`${item.mediaType}:${item.tmdbId}`, status);
        }
      }
      mediaStatusCache = {
        expiresAt: Date.now() + 60_000,
        statuses,
      };
      return statuses;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Seerr media list request failed";
      console.error(`Unable to load Seerr media statuses: ${message}`);
      return new Map();
    }
  }

  router.get("/search", async (req, res) => {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    if (query.trim() === "") {
      res.status(400).json({ error: "query is required" });
      return;
    }

    const pageRaw = req.query.page;
    const page =
      typeof pageRaw === "string" && /^\d+$/.test(pageRaw)
        ? Number(pageRaw)
        : 1;

    try {
      const result = await tmdb.search(query, page);
      const statuses = await getMediaStatuses();
      res.json({
        ...result,
        results: result.results.map((item) =>
          annotateMediaStatus(item, statuses),
        ),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/trending", async (_req, res) => {
    try {
      const results = await tmdb.trending();
      const statuses = await getMediaStatuses();
      res.json({
        results: results.map((item) => annotateMediaStatus(item, statuses)),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/movie/:id", async (req, res) => {
    const id = parseNumericId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid movie id" });
      return;
    }

    try {
      const detail = await tmdb.movieDetail(id);
      const statuses = await getMediaStatuses();
      res.json(annotateMediaStatus(detail, statuses));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/tv/:id", async (req, res) => {
    const id = parseNumericId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid tv id" });
      return;
    }

    try {
      const detail = await tmdb.tvDetail(id);
      const statuses = await getMediaStatuses();
      res.json(annotateMediaStatus(detail, statuses));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  return router;
}

export function annotateMediaStatus<
  T extends { tmdbId: number; mediaType: "movie" | "tv" },
>(
  item: T,
  statuses: ReadonlyMap<string, MediaAvailability>,
): T & { mediaStatus: MediaAvailability | null } {
  return {
    ...item,
    mediaStatus: statuses.get(`${item.mediaType}:${item.tmdbId}`) ?? null,
  };
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
    err instanceof TmdbUpstreamError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
