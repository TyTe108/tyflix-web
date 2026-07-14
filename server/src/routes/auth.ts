import { Router } from "express";
import {
  PlexUpstreamError,
  type PlexClient,
} from "../plex/client";

export function createAuthRouter(plex: PlexClient): Router {
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
      res.json({
        status: "ok",
        plexUser: {
          id: plexUser.id,
          username: plexUser.username,
          email: plexUser.email,
          thumb: plexUser.thumb,
        },
      });
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
    err instanceof PlexUpstreamError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Plex request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
