// The two authorization gates, and the only ones. Authorization in Tyflix is
// entirely server-side: the SPA hides admin nav for tidiness, but nothing is
// actually protected until one of these runs.
//
// Both are factories rather than plain middleware because they need
// sessionSecret, the Seerr client, and the session-revocation store, which live
// in config / startup wiring and aren't module globals. index.ts mounts them
// per router (`requireAuth(config.sessionSecret, seerr, sessionRevocation)`),
// and a couple of routers build their own copy internally when only some of
// their routes need the gate.
//
// The contract for everything downstream: after requireAuth, res.locals.session
// holds a verified SessionPayload whose `permissions` have been freshly
// re-checked against Seerr for this request (not merely signature-verified
// from the cookie). The cookie itself is not rewritten.

import type { NextFunction, Request, Response } from "express";
import type { SeerrClient } from "../seerr/client";
import type { SessionRevocationStore } from "../sessionRevocation";
import { isAdmin, readSession, type SessionPayload } from "../session";
import {
  revalidateSessionPermissions,
  type RevalidatePermissionsOptions,
} from "./revalidatePermissions";

export type AuthGateOptions = RevalidatePermissionsOptions;

/**
 * Rejects anonymous requests with 401 and publishes the session on
 * `res.locals.session` for handlers further down the chain.
 *
 * readSession collapses every failure into null, so there's one 401 body here
 * whether the cookie was missing, forged, or just expired. A verified cookie
 * still has to clear revocation and a live Seerr permission check: revoked or
 * missing account -> 401, Seerr unreachable/timed out -> 503. On success,
 * `permissions` on res.locals.session is Seerr's current value for this
 * request only.
 */
export function requireAuth(
  sessionSecret: string,
  seerr: Pick<SeerrClient, "getUserById">,
  revocation: Pick<SessionRevocationStore, "isRevoked">,
  options: AuthGateOptions = {},
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const session = readSession(req, sessionSecret);
    if (session === null) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    const result = await revalidateSessionPermissions(
      session,
      seerr,
      revocation,
      options,
    );
    if (result.status === "revoked" || result.status === "not_found") {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    if (result.status === "unreachable") {
      res.status(503).json({ error: "seerr unavailable" });
      return;
    }

    res.locals.session = {
      ...session,
      permissions: result.permissions,
    } satisfies SessionPayload;
    next();
  };
}

/**
 * requireAuth plus a check of the Seerr admin bit. 401 when there's no valid
 * session (or Seerr says the account is gone, or the session is revoked), 503
 * when Seerr can't be reached, 403 when the live permissions lack the admin bit.
 *
 * Admin status is re-checked against Seerr on every request, so a revoke or
 * grant takes effect on the next request without waiting for re-login.
 */
export function requireAdmin(
  sessionSecret: string,
  seerr: Pick<SeerrClient, "getUserById">,
  revocation: Pick<SessionRevocationStore, "isRevoked">,
  options: AuthGateOptions = {},
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    // Delegate to requireAuth and use its `next` callback as the continuation.
    // If auth fails it has already sent the response and never calls back, so
    // the admin check below only ever runs against a Seerr-revalidated session.
    // The cast is needed because res.locals is typed as `any` by Express.
    await requireAuth(sessionSecret, seerr, revocation, options)(req, res, () => {
      const session = res.locals.session as SessionPayload | undefined;
      if (!session || !isAdmin(session.permissions)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      next();
    });
  };
}
