// Login. Mounted at /api/auth with four endpoints: POST /plex/start,
// GET /plex/check, GET /me and POST /logout.
//
// Public by necessity. This is the surface that creates a session, so it can't
// sit behind requireAuth. GET /me reads and verifies the cookie itself instead
// of relying on middleware (and then revalidates permissions via the same
// helper requireAuth uses), which is why it lives here rather than in me.ts.
//
// The flow is Plex's PIN handshake, the same one their own apps use. We ask
// plex.tv for a PIN, the browser opens Plex's auth page in a popup, and the SPA
// polls /plex/check until Plex attaches an auth token to that PIN. Two
// upstreams: Plex for the PIN and the account, Seerr to confirm the account is
// actually a member and to pull permissions.
//
// The Plex token that comes back never reaches the browser. issueSession
// encrypts it into the signed httpOnly cookie, and only server code ever
// decrypts it.

import { Router } from "express";
import { revalidateSessionPermissions } from "../middleware/revalidatePermissions";
import { PlexUpstreamError, type PlexClient } from "../plex/client";
import {
  SeerrUpstreamError,
  type SeerrClient,
  type SeerrUser,
} from "../seerr/client";
import type { SessionRevocationStore } from "../sessionRevocation";
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
  // False in development so the cookie survives plain http://localhost.
  secureCookies: boolean;
  sessionRevocation: SessionRevocationStore;
};

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const { plex, seerr, sessionSecret, secureCookies, sessionRevocation } = deps;
  const router = Router();

  /**
   * POST /api/auth/plex/start
   *
   * Opens the PIN handshake. Returns `{ pinId, code, authUrl }`; the SPA sends
   * the browser to authUrl in a popup and then polls /plex/check with pinId.
   * Reads no params. 502 if plex.tv won't hand out a PIN.
   */
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

  /**
   * GET /api/auth/plex/check?pinId=<id>
   *
   * The polling half of the login. While the user hasn't finished on Plex's
   * side this answers 200 `{ status: "pending" }` and touches nothing else.
   * Once Plex attaches a token it sets the session cookie and returns
   * `{ status: "ok", user, isAdmin }`.
   *
   * 400 for a missing or non-numeric pinId, 403 `{ status: "forbidden" }` when
   * the Plex account isn't a member of this server, 502 for any other upstream
   * failure. A 403 issues no cookie.
   *
   * Polling means this runs repeatedly for one login, so the pending path
   * deliberately stops before any Seerr work.
   */
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

      // Membership is settled, so mint the session. The raw Plex auth token
      // goes in here and gets encrypted inside the cookie; the response below
      // deliberately carries identity fields only.
      issueSession(
        res,
        {
          seerrUserId: seerrUser.id,
          plexId: seerrUser.plexId,
          plexUsername: seerrUser.plexUsername,
          displayName: seerrUser.displayName,
          avatar: plexUser.thumb,
          permissions: seerrUser.permissions,
          plexToken: authToken,
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

  /**
   * GET /api/auth/me
   *
   * Who's signed in. Verifies the cookie, then re-checks revocation and
   * permissions against Seerr (same helper as requireAuth). Returns
   * `{ user, isAdmin }` with the live permissions, 401 when the cookie is
   * missing/tampered/expired/revoked or Seerr says the account is gone, and
   * 503 when Seerr is unreachable.
   *
   * Note the `user` block leaves out email: that only comes back from
   * /plex/check, since the session doesn't carry it. The cookie is not
   * rewritten — fresh permissions are response-only.
   */
  router.get("/me", async (req, res) => {
    const session = readSession(req, sessionSecret);
    if (session === null) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    const result = await revalidateSessionPermissions(
      session,
      seerr,
      sessionRevocation,
    );
    if (result.status === "revoked" || result.status === "not_found") {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    if (result.status === "unreachable") {
      res.status(503).json({ error: "seerr unavailable" });
      return;
    }

    res.json({
      user: {
        seerrUserId: session.seerrUserId,
        plexId: session.plexId,
        plexUsername: session.plexUsername,
        displayName: session.displayName,
        avatar: session.avatar,
        permissions: result.permissions,
      },
      isAdmin: isAdmin(result.permissions),
    });
  });

  /**
   * POST /api/auth/logout
   *
   * Revokes every session for this user (durably, before responding), clears
   * the browser cookie, and returns `{ ok: true }`. Always 200, even without
   * a session, so the client never has to special-case it. A write failure
   * during revoke is not swallowed into ok:true — it surfaces as an error.
   * Nothing is revoked on Plex's side; the encrypted token simply stops being
   * accepted here.
   */
  router.post("/logout", async (req, res) => {
    const session = readSession(req, sessionSecret);
    if (session !== null) {
      await sessionRevocation.revokeSessionsBefore(session.seerrUserId);
    }
    clearSession(res, { secure: secureCookies });
    res.json({ ok: true });
  });

  return router;
}

// Splits "you're not a member" from "Seerr is broken". The first is a normal
// 403 for the user; the second has to surface as a 502 so a Seerr outage never
// looks like a rejected login.
function isSeerrAccessDenied(status: number): boolean {
  // Seerr refuses accounts without Plex-server access with a 403 (verified on
  // the live instance); 401/422 are treated the same defensively. Anything
  // else (500, network) is a genuine upstream failure -> 502.
  return status === 401 || status === 403 || status === 422;
}

// Anything Plex or Seerr throws that isn't a membership rejection ends up here
// as a 502, with the upstream message logged and echoed.
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
