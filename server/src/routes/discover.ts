import { Router } from "express";
import type { MediaAvailability } from "../seerr/client";
import type { MediaStatusProvider } from "../seerr/mediaStatusProvider";
import { TmdbUpstreamError, type TmdbClient } from "../tmdb/client";
import { NETWORKS, STUDIOS } from "../tmdb/studios";

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

  router.get("/upcoming", async (req, res) => {
    const mediaType = req.query.mediaType;
    if (mediaType !== "movie" && mediaType !== "tv") {
      res.status(400).json({ error: "invalid media type" });
      return;
    }

    try {
      const results = await tmdb.upcoming(mediaType);
      const statuses = await getStatusMapOrEmpty(mediaStatus);
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

  router.get("/studios", (_req, res) => {
    res.json({ studios: STUDIOS, networks: NETWORKS });
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
    const companyId = parseOptionalNumericQuery(req.query.companyId);
    if (companyId === null) {
      res.status(400).json({ error: "invalid company id" });
      return;
    }
    const networkId = parseOptionalNumericQuery(req.query.networkId);
    if (networkId === null) {
      res.status(400).json({ error: "invalid network id" });
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
        ...(mediaType === "movie" && companyId !== undefined
          ? { companyId }
          : {}),
        ...(mediaType === "tv" && networkId !== undefined
          ? { networkId }
          : {}),
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

  router.get("/:mediaType/:id/credits", async (req, res) => {
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
      res.json(await tmdb.credits(mediaType, id));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/person/:id", async (req, res) => {
    const id = parseNumericId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid person id" });
      return;
    }

    try {
      const [person, credits] = await Promise.all([
        tmdb.person(id),
        tmdb.personCredits(id),
      ]);
      const statuses = await getStatusMapOrEmpty(mediaStatus);
      res.json({
        person,
        credits: credits.map((item) => annotateMediaStatus(item, statuses)),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/collection/:id", async (req, res) => {
    const id = parseNumericId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid collection id" });
      return;
    }

    try {
      const collection = await tmdb.collection(id);
      const statuses = await getStatusMapOrEmpty(mediaStatus);
      res.json({
        ...collection,
        parts: collection.parts.map((item) =>
          annotateMediaStatus(item, statuses),
        ),
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
