import { Router } from "express";
import {
  PlexServerUpstreamError,
  type LibrarySortKey,
  type PlexServerClient,
} from "../plex/server";

const LIBRARY_SORT_KEYS = new Set<LibrarySortKey>([
  "title",
  "added",
  "year",
  "rating",
]);

const LIBRARY_IMAGE_PATH_RE =
  /^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/;

export type LibraryRouterDeps = {
  plexServer: PlexServerClient;
};

export function createLibraryRouter(deps: LibraryRouterDeps): Router {
  const { plexServer } = deps;
  const router = Router();

  router.get("/image", async (req, res) => {
    const path = req.query.path;
    if (typeof path !== "string") {
      res.status(400).json({ error: "path is required" });
      return;
    }
    if (!LIBRARY_IMAGE_PATH_RE.test(path)) {
      res.status(400).json({ error: "invalid image path" });
      return;
    }

    try {
      const result = await plexServer.fetchImage(path);
      if (!result.ok) {
        res.status(502).json({ error: "image fetch failed" });
        return;
      }
      res.set("Content-Type", result.contentType ?? "image/jpeg");
      res.set("Cache-Control", "public, max-age=86400");
      res.send(result.body);
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/sections", async (_req, res) => {
    try {
      const sections = await plexServer.sections();
      res.json({ sections });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/sections/:key/items", async (req, res) => {
    const sectionKey = req.params.key;
    if (!/^\d+$/.test(sectionKey)) {
      res.status(400).json({ error: "invalid section key" });
      return;
    }

    const sortRaw =
      typeof req.query.sort === "string" ? req.query.sort : "title";
    if (!isLibrarySortKey(sortRaw)) {
      res.status(400).json({ error: "invalid sort" });
      return;
    }
    const sort = sortRaw;

    const start = parseBoundedIntQuery(req.query.start, { min: 0 });
    if (start === null) {
      res.status(400).json({ error: "invalid start" });
      return;
    }

    const size = parseBoundedIntQuery(req.query.size, { min: 1, max: 100 });
    if (size === null) {
      res.status(400).json({ error: "invalid size" });
      return;
    }

    try {
      const result = await plexServer.sectionItems({
        sectionKey,
        sort,
        start: start ?? 0,
        size: size ?? 50,
      });
      res.json({
        items: result.items,
        totalSize: result.totalSize,
        start: start ?? 0,
        size: size ?? 50,
        sort,
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  return router;
}

function isLibrarySortKey(value: string): value is LibrarySortKey {
  return LIBRARY_SORT_KEYS.has(value as LibrarySortKey);
}

function parseBoundedIntQuery(
  raw: unknown,
  bounds: { min: number; max?: number },
): number | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (value < bounds.min) {
    return null;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    return null;
  }
  return value;
}

function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof PlexServerUpstreamError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
