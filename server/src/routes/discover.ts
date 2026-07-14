import { Router } from "express";
import { TmdbUpstreamError, type TmdbClient } from "../tmdb/client";

export type DiscoverRouterDeps = {
  tmdb: TmdbClient;
};

export function createDiscoverRouter(deps: DiscoverRouterDeps): Router {
  const { tmdb } = deps;
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
      res.json(result);
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/trending", async (_req, res) => {
    try {
      const results = await tmdb.trending();
      res.json({ results });
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
      res.json(detail);
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
      res.json(detail);
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  return router;
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
