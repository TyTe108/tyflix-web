import { Router } from "express";

export type PublicConfigRouterDeps = {
  accessRequestsEnabled: boolean;
};

/**
 * Public feature flags only. Never put secrets, paths, versions, tokens, or
 * other config values here — this endpoint is unauthenticated and it will be
 * tempting to grow it later.
 */
export function createConfigRouter(deps: PublicConfigRouterDeps): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({
      accessRequestsEnabled: deps.accessRequestsEnabled,
    });
  });

  return router;
}
