import { Router } from "express";
import {
  DashboardUpstreamError,
  type DashboardClient,
} from "../dashboard/client";
import {
  PlexConnectionError,
  type PlexConnectionResolver,
} from "../plex/connection";
import {
  PlexTransientError,
  type TransientTokenMinter,
} from "../plex/transientToken";
import { readPlexToken, type SessionPayload } from "../session";

export type AdminRouterDeps = {
  dashboard: DashboardClient;
  plexConnection: PlexConnectionResolver;
  transientMinter: TransientTokenMinter;
  sessionSecret: string;
  plexBaseUrl: string;
};

const PROXY_PATHS = ["system", "users", "jobs", "containers"] as const;

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const {
    dashboard,
    plexConnection,
    transientMinter,
    sessionSecret,
    plexBaseUrl,
  } = deps;
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

  // TEMPORARY probe: recovers the admin's own durable Plex token, mints a
  // short-lived transient from it, and verifies the transient authenticates
  // against our Plex server. Verification hits the LAN base URL (which the
  // backend can always reach) rather than the external plex.direct URL — NAT
  // hairpin means the server can't reach its own public IP, which produced a
  // false negative. directUri is still returned for info. Confirms the
  // 15.1/15.2/15.3 chain end to end. Admin-gated (requireAdmin at mount time).
  // The full transient token is never returned. REMOVE once the /api/watch
  // play-decision endpoint lands.
  router.get("/plex-transient", async (_req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (session === undefined) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    let userToken: string | null;
    try {
      // readPlexToken throws on a tampered/corrupt blob; let that surface as 502.
      userToken = readPlexToken(session, sessionSecret);
    } catch (err) {
      respondUpstreamError(res, err);
      return;
    }

    if (userToken === null) {
      res
        .status(409)
        .json({ error: "no stored Plex token; re-login required" });
      return;
    }

    try {
      const transient = await transientMinter.mint(userToken);
      const directUri = await plexConnection.resolveExternalUri();
      const authenticatesAgainstServer = await verifyAgainstServer(
        plexBaseUrl,
        transient,
      );

      res.json({
        ok: true,
        tokenLength: transient.length,
        tokenPreview: maskToken(transient),
        authenticatesAgainstServer,
        directUri,
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  return router;
}

// Confirms a transient token works against an AUTH-REQUIRED endpoint on the LAN
// base URL. /library/sections requires a token (unlike /identity), so a 200 is
// a genuine positive. We use the LAN URL because the backend can always reach
// it (the external plex.direct URL is unreachable from inside the LAN via NAT
// hairpin). A failure is reported as false rather than thrown so the probe can
// surface it.
async function verifyAgainstServer(
  baseUrl: string,
  transient: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/library/sections`, {
      method: "GET",
      headers: {
        "X-Plex-Token": transient,
        Accept: "application/json",
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Masks all but the first 6 / last 4 characters so the probe never leaks a
// usable token.
function maskToken(token: string): string {
  if (token.length <= 10) {
    return "*".repeat(token.length);
  }
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof DashboardUpstreamError ||
    err instanceof PlexConnectionError ||
    err instanceof PlexTransientError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
