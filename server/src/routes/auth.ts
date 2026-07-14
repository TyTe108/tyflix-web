import { Router } from "express";
import { PlexUpstreamError, type PlexClient } from "../plex/client";
import { SeerrUpstreamError, type SeerrClient } from "../seerr/client";
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
      const seerrUser = await seerr.getUserByPlexId(plexUser.id);

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
