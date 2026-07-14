import { Router } from "express";
import {
  DashboardUpstreamError,
  type DashboardClient,
} from "../dashboard/client";

export type AdminRouterDeps = {
  dashboard: DashboardClient;
};

const PROXY_PATHS = ["system", "users", "jobs", "containers"] as const;

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
