import { Router } from "express";
import {
  DashboardUpstreamError,
  type DashboardClient,
} from "../dashboard/client";
import {
  PlexConnectionError,
  type PlexConnectionResolver,
} from "../plex/connection";

export type AdminRouterDeps = {
  dashboard: DashboardClient;
  plexConnection: PlexConnectionResolver;
};

const PROXY_PATHS = ["system", "users", "jobs", "containers"] as const;

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const { dashboard, plexConnection } = deps;
  const router = Router();

  for (const name of PROXY_PATHS) {
    router.get(`/${name}`, async (_req, res) => {
      try {
        const body = await dashboard.getJson(`/api/${name}`);
        res.json(body);
      } catch (err) {
        respondUpstreamError(res, err);
      }
    });
  }

  // TEMPORARY probe: returns our server's direct external plex.direct base URL
  // so the upcoming play-decision endpoint can be built against a real address.
  // Admin-gated (requireAdmin at mount time). REMOVE once the /api/watch
  // play-decision endpoint lands.
  router.get("/plex-connection", async (_req, res) => {
    try {
      const uri = await plexConnection.resolveExternalUri();
      res.json({ uri });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  return router;
}

function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof DashboardUpstreamError || err instanceof PlexConnectionError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
