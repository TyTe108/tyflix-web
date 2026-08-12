// Login. Mounted at /api/auth with three endpoints: POST /plex/complete,
// GET /me and POST /logout.
//
// Public by necessity. This is the surface that creates a session, so it can't
// sit behind requireAuth. GET /me reads and verifies the cookie itself instead
// of relying on middleware (and then revalidates permissions via the same
// helper requireAuth uses), which is why it lives here rather than in me.ts.
//
// Sign-in is a one-shot hand-off. The browser runs Plex's PIN handshake against
// plex.tv itself, then POSTs the resulting authToken to /plex/complete. We
// validate it with plex.getUser, confirm membership via Seerr, and mint the
// session cookie. The token transits the browser in memory during that
// handshake only; afterward the browser holds nothing but the httpOnly cookie.
// issueSession encrypts the token into the cookie, and only server code ever
// decrypts it.

import { Router, type RequestHandler, type Response } from "express";
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

// Upper bound on a client-supplied Plex auth token. Real tokens are far
// shorter; this only stops oversized request bodies from reaching upstream.
const MAX_AUTH_TOKEN_LENGTH = 1024;

export type AuthRouterDeps = {
  plex: PlexClient;
  seerr: SeerrClient;
  sessionSecret: string;
  // False in development so the cookie survives plain http://localhost.
  secureCookies: boolean;
  sessionRevocation: SessionRevocationStore;
  // Optional; production mounts plexCompleteLimiter. Tests omit it so the
  // suite never trips 429s.
  completeLimiter?: RequestHandler;
};

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const {
    plex,
    seerr,
    sessionSecret,
    secureCookies,
    sessionRevocation,
    completeLimiter,
  } = deps;
  const router = Router();

  /**
   * POST /api/auth/plex/complete
   *
   * Accepts a Plex authToken the browser obtained itself (PIN create + poll
   * against plex.tv) and runs membership check + session mint. Body:
   * `{ authToken: string }`.
   *
   * 200 `{ status: "ok", user, isAdmin }` plus the session cookie on success.
   * 400 for a missing/non-object body or a missing/non-string/empty/whitespace/
   * overlong authToken (no upstream call). 401 when plex.tv rejects the token.
   * 403 `{ status: "forbidden" }` when the account isn't a Tyflix member.
   * 502 for any other upstream failure. A 4xx issues no cookie.
   */
  const completeHandlers: RequestHandler[] = [];
  if (completeLimiter !== undefined) {
    completeHandlers.push(completeLimiter);
  }
  completeHandlers.push(async (req, res) => {
    const body = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      res.status(400).json({ error: "authToken is required" });
      return;
    }

    const authToken = (body as { authToken?: unknown }).authToken;
    if (typeof authToken !== "string" || authToken.trim() === "") {
      res.status(400).json({ error: "authToken is required" });
      return;
    }
    if (authToken.length > MAX_AUTH_TOKEN_LENGTH) {
      res.status(400).json({ error: "authToken is too long" });
      return;
    }

    try {
      await establishSessionFromPlexToken(res, authToken, {
        plex,
        seerr,
        sessionSecret,
        secureCookies,
      });
    } catch (err) {
      // Client-supplied token: a plex.tv 401 is an expected input error, not an
      // upstream outage, so it must not fall into the 502 path.
      if (err instanceof PlexUpstreamError && err.status === 401) {
        res.status(401).json({ error: "invalid authToken" });
        return;
      }
      respondUpstreamError(res, err);
    }
  });
  router.post("/plex/complete", ...completeHandlers);

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
   * /plex/complete, since the session doesn't carry it. The cookie is not
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

// /plex/complete: validate with plex.getUser, confirm membership via Seerr,
// mint the session cookie, and write the ok body. The route owns the outer
// try/catch so it can map a plex.tv 401 to 401 instead of 502.
async function establishSessionFromPlexToken(
  res: Response,
  authToken: string,
  deps: {
    plex: PlexClient;
    seerr: SeerrClient;
    sessionSecret: string;
    secureCookies: boolean;
  },
): Promise<void> {
  const { plex, seerr, sessionSecret, secureCookies } = deps;

  const plexUser = await plex.getUser(authToken);

  // Sign the user into Seerr via its own Plex sign-in. This onboards a
  // brand-new Plex-server member and refreshes an existing user's stored
  // Plex token so Watchlist auto-request works. Seerr rejects anyone
  // without Plex-server access (401/403/422), which stays a 403 for us.
  let signedInUser: SeerrUser | null;
  try {
    signedInUser = await seerr.signInWithPlex(authToken);
  } catch (err) {
    if (err instanceof SeerrUpstreamError && isSeerrAccessDenied(err.status)) {
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
