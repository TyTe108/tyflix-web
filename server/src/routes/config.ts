// Public feature-flag probe. Mounted at /api/config by index.ts.
//
// GET / is the one endpoint here. It hands the SPA the booleans it needs while
// still logged out: whether self-serve access requests and the Transmission
// admin panel are wired up. Deliberately not behind requireAuth, and there are
// no upstream calls at all.
//
// The values come from what index.ts managed to construct at boot.

import { Router } from "express";

// Flags index.ts resolves at startup and passes in. Booleans only, on purpose.
export type PublicConfigRouterDeps = {
  accessRequestsEnabled: boolean;
  transmissionEnabled: boolean;
};

/**
 * Public feature flags only. Never put secrets, paths, versions, tokens, or
 * other config values here — this endpoint is unauthenticated and it will be
 * tempting to grow it later.
 */
export function createConfigRouter(deps: PublicConfigRouterDeps): Router {
  const router = Router();

  /**
   * GET /api/config
   *
   * Returns the public flag set. Reads nothing from the request, always 200,
   * and can't fail because there's no I/O behind it.
   */
  router.get("/", (_req, res) => {
    res.json({
      accessRequestsEnabled: deps.accessRequestsEnabled,
      transmissionEnabled: deps.transmissionEnabled,
    });
  });

  return router;
}
