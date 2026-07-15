import { Router } from "express";
import type { MediaAvailability } from "../seerr/client";
import type { MediaStatusProvider } from "../seerr/mediaStatusProvider";
import { TmdbUpstreamError, type TmdbClient } from "../tmdb/client";

export type DiscoverRouterDeps = {
  tmdb: TmdbClient;
  mediaStatus: MediaStatusProvider;
};

export function createDiscoverRouter(deps: DiscoverRouterDeps): Router {
  const { tmdb, mediaStatus } = deps;
  const router = Router();

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
      const statuses = await mediaStatus.getStatusMap();
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
      const statuses = await mediaStatus.getStatusMap();
      res.json({
        results: results.map((item) => annotateMediaStatus(item, statuses)),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/genres", async (req, res) => {
    const mediaType = req.query.mediaType;
    if (mediaType !== "movie" && mediaType !== "tv") {
      res.status(400).json({ error: "invalid media type" });
      return;
    }

    try {
      res.json({ results: await tmdb.genres(mediaType) });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/browse", async (req, res) => {
    const mediaType = req.query.mediaType;
    if (mediaType !== "movie" && mediaType !== "tv") {
      res.status(400).json({ error: "invalid media type" });
      return;
    }

    const genreId = parseOptionalNumericQuery(req.query.genreId);
    if (genreId === null) {
      res.status(400).json({ error: "invalid genre id" });
      return;
    }
    const page = parseOptionalNumericQuery(req.query.page);
    if (page === null) {
      res.status(400).json({ error: "invalid page" });
      return;
    }

    try {
      const result = await tmdb.discover(mediaType, {
        ...(genreId !== undefined ? { genreId } : {}),
        ...(page !== undefined ? { page } : {}),
      });
      const statuses = await getStatusMapOrEmpty(mediaStatus);
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

  router.get("/:mediaType/:id/recommendations", async (req, res) => {
    const mediaType = req.params.mediaType;
    if (mediaType !== "movie" && mediaType !== "tv") {
      res.status(400).json({ error: "invalid media type" });
      return;
    }

    const id = parseNumericId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: `invalid ${mediaType} id` });
      return;
    }

    try {
      const results = await tmdb.recommendations(mediaType, id);
      const statuses = await getStatusMapOrEmpty(mediaStatus);
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
      const statuses = await mediaStatus.getStatusMap();
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
      const statuses = await mediaStatus.getStatusMap();
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

function parseOptionalNumericQuery(
  raw: unknown,
): number | undefined | null {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

async function getStatusMapOrEmpty(
  mediaStatus: MediaStatusProvider,
): Promise<ReadonlyMap<string, MediaAvailability>> {
  try {
    return await mediaStatus.getStatusMap();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Seerr media status request failed";
    console.error(`Unable to load Seerr media statuses: ${message}`);
    return new Map();
  }
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
