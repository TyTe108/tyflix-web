// The signed-in user's Plex Watchlist. Mounted at /api/watchlist behind
// requireAuth, and GET / is the only endpoint.
//
// Plex owns the watchlist itself, but Seerr already mirrors it per user, so
// this reads Seerr rather than talking to plex.tv again. Three upstreams get
// stitched together: Seerr for the list, Seerr's media table for availability
// (is it on the server yet?), and TMDB for posters, since the watchlist rows
// come back with ids and not much else.

import { Router } from "express";
import type { SeerrClient } from "../seerr/client";
import type { MediaStatusProvider } from "../seerr/mediaStatusProvider";
import type { SessionPayload } from "../session";
import {
  mediaEnrichmentKey,
  type MediaEnrichment,
} from "../tmdb/enrichment";
import { annotateMediaStatus } from "./discover";

export type WatchlistRouterDeps = {
  seerr: Pick<SeerrClient, "listUserWatchlist">;
  mediaStatus: MediaStatusProvider;
  mediaEnrichment: MediaEnrichment;
};

export function createWatchlistRouter(
  deps: WatchlistRouterDeps,
): Router {
  const { seerr, mediaStatus, mediaEnrichment } = deps;
  const router = Router();

  /**
   * GET /api/watchlist
   *
   * Returns `{ results }`, one row per watchlist entry, each carrying Seerr's
   * availability under `mediaStatus` and a TMDB `posterUrl` (null when the
   * lookup missed). Takes no query or body params; the user comes from the
   * session.
   *
   * 401 without a session, 502 if Seerr fails. A TMDB miss doesn't fail the
   * request, it just leaves that poster null.
   */
  router.get("/", async (_req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    try {
      // The list and the availability map don't depend on each other, so pay
      // for one round trip instead of two.
      const [items, statuses] = await Promise.all([
        seerr.listUserWatchlist(session.seerrUserId),
        mediaStatus.getStatusMap(),
      ]);
      const annotated = items.map((item) =>
        annotateMediaStatus(item, statuses),
      );
      // Poster lookups run in parallel, deduped by tmdbId and cached for ten
      // minutes inside the enrichment helper, so a repeat title is free.
      const enriched = await mediaEnrichment.enrich(annotated);
      res.json({
        results: annotated.map((item) => ({
          ...item,
          posterUrl:
            enriched.get(mediaEnrichmentKey(item))?.posterUrl ?? null,
        })),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Seerr watchlist request failed";
      console.error(message);
      res.status(502).json({ error: message });
    }
  });

  return router;
}
