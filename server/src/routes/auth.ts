import { Router } from "express";
import { PlexUpstreamError, type PlexClient } from "../plex/client";
import {
  SeerrUpstreamError,
  type SeerrClient,
  type SeerrUser,
} from "../seerr/client";
import {
  clearSession,
  isAdmin,
  issueSession,
  readSession,
} from "../session";

export type AuthRouterDeps = {
  plex: PlexClient;
  seerr: SeerrClient;
  sessionSecret: string;
  secureCookies: boolean;
};

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const { plex, seerr, sessionSecret, secureCookies } = deps;
  const router = Router();

  router.post("/plex/start", async (_req, res) => {
    try {
      const pin = await plex.createPin();
      const authUrl = plex.buildAuthUrl(pin.code);
      res.json({
        pinId: pin.id,
        code: pin.code,
        authUrl,
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/plex/check", async (req, res) => {
    const pinIdRaw = req.query.pinId;
    if (typeof pinIdRaw !== "string" || pinIdRaw.trim() === "") {
      res.status(400).json({ error: "pinId is required" });
      return;
    }
    if (!/^\d+$/.test(pinIdRaw)) {
      res.status(400).json({ error: "pinId must be numeric" });
      return;
    }

    const pinId = Number(pinIdRaw);

    try {
      const { authToken } = await plex.checkPin(pinId);
      if (authToken === null) {
        res.json({ status: "pending" });
        return;
      }

      const plexUser = await plex.getUser(authToken);

      // Sign the user into Seerr via its own Plex sign-in. This onboards a
      // brand-new Plex-server member and refreshes an existing user's stored
      // Plex token so Watchlist auto-request works. Seerr rejects anyone
      // without Plex-server access (401/403/422), which stays a 403 for us.
      let signedInUser: SeerrUser | null;
      try {
        signedInUser = await seerr.signInWithPlex(authToken);
      } catch (err) {
        if (
          err instanceof SeerrUpstreamError &&
          isSeerrAccessDenied(err.status)
        ) {
          res.status(403).json({
            status: "forbidden",
            message: "Your Plex account isn't a Tyflix member.",
          });
          return;
        }
        throw err;
      }

      // Seerr's sign-in response omits plexId, so resolve the authoritative
      // user record (which carries plexId + permissions) when needed.
      const seerrUser =
        signedInUser ?? (await seerr.getUserByPlexId(plexUser.id));

      if (seerrUser === null) {
        res.status(403).json({
          status: "forbidden",
          message: "Your Plex account isn't a Tyflix member.",
        });
        return;
      }

      issueSession(
        res,
        {
          seerrUserId: seerrUser.id,
          plexId: seerrUser.plexId,
          plexUsername: seerrUser.plexUsername,
          displayName: seerrUser.displayName,
          avatar: plexUser.thumb,
          permissions: seerrUser.permissions,
        },
        { secret: sessionSecret, secure: secureCookies },
      );

      res.json({
        status: "ok",
        user: {
          seerrUserId: seerrUser.id,
          plexId: seerrUser.plexId,
          plexUsername: seerrUser.plexUsername,
          displayName: seerrUser.displayName,
          email: seerrUser.email,
          avatar: plexUser.thumb,
          permissions: seerrUser.permissions,
        },
        isAdmin: isAdmin(seerrUser.permissions),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/me", (req, res) => {
    const session = readSession(req, sessionSecret);
    if (session === null) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    res.json({
      user: {
        seerrUserId: session.seerrUserId,
        plexId: session.plexId,
        plexUsername: session.plexUsername,
        displayName: session.displayName,
        avatar: session.avatar,
        permissions: session.permissions,
      },
      isAdmin: isAdmin(session.permissions),
    });
  });

  router.post("/logout", (_req, res) => {
    clearSession(res, { secure: secureCookies });
    res.json({ ok: true });
  });

  return router;
}

function isSeerrAccessDenied(status: number): boolean {
  // Seerr refuses accounts without Plex-server access with a 403 (verified on
  // the live instance); 401/422 are treated the same defensively. Anything
  // else (500, network) is a genuine upstream failure -> 502.
  return status === 401 || status === 403 || status === 422;
}

function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof PlexUpstreamError || err instanceof SeerrUpstreamError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
