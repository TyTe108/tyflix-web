// Read-only JSON proxy in front of the host-metrics service that backs the
// admin dashboard. Mounted at /api/admin behind requireAdmin, so every route
// here needs a session whose Seerr permission bits include admin.
//
// GET /system, GET /users, GET /jobs and GET /containers are the whole surface.
// Each one maps 1:1 onto /api/<name> on the metrics service and passes the body
// straight through untouched. The client sends no credentials upstream, so the
// admin check on this mount is the only thing standing in front of that
// service's data.
//
// Note that /api/admin/access-requests is a different router entirely, mounted
// ahead of this one in index.ts.

import { Router } from "express";
import {
  DashboardUpstreamError,
  type DashboardClient,
} from "../dashboard/client";

export type AdminRouterDeps = {
  dashboard: DashboardClient;
};

// One GET route is generated per entry. Adding a name here is the only step
// needed to expose another dashboard endpoint.
const PROXY_PATHS = ["system", "users", "jobs", "containers"] as const;

/**
 * Builds the admin dashboard proxy router.
 *
 * Every route is generated from PROXY_PATHS, so they all behave identically:
 * no query or body params are read, a 200 carries the metrics service's JSON
 * verbatim, and any failure comes back as 502 with the upstream message.
 */
export function createAdminRouter(deps: AdminRouterDeps): Router {
  const { dashboard } = deps;
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

  return router;
}

// Collapses everything to a 502. DashboardUpstreamError carries the real
// upstream status, but it isn't forwarded: a sick metrics service shouldn't be
// able to make this API answer 404 or 403 on the admin's behalf.
function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof DashboardUpstreamError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
