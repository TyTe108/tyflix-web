import { Router } from "express";
import type { SeerrClient } from "../seerr/client";
import type { MediaStatusProvider } from "../seerr/mediaStatusProvider";
import type { SessionPayload } from "../session";
import { annotateMediaStatus } from "./discover";

export type WatchlistRouterDeps = {
  seerr: Pick<SeerrClient, "listUserWatchlist">;
  mediaStatus: MediaStatusProvider;
};

export function createWatchlistRouter(
  deps: WatchlistRouterDeps,
): Router {
  const { seerr, mediaStatus } = deps;
  const router = Router();

  router.get("/", async (_req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    try {
      const [items, statuses] = await Promise.all([
        seerr.listUserWatchlist(session.seerrUserId),
        mediaStatus.getStatusMap(),
      ]);
      res.json({
        results: items.map((item) => annotateMediaStatus(item, statuses)),
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
