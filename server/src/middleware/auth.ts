// The two authorization gates, and the only ones. Authorization in Tyflix is
// entirely server-side: the SPA hides admin nav for tidiness, but nothing is
// actually protected until one of these runs.
//
// Both are factories rather than plain middleware because they need
// sessionSecret, which lives in config and isn't a module global. index.ts
// mounts them per router (`requireAuth(config.sessionSecret)`), and a couple of
// routers build their own copy internally when only some of their routes need
// the gate.
//
// The contract for everything downstream: after requireAuth, res.locals.session
// holds a verified SessionPayload. Routers read it from there instead of
// re-parsing the cookie.

import type { NextFunction, Request, Response } from "express";
import { isAdmin, readSession, type SessionPayload } from "../session";

/**
 * Rejects anonymous requests with 401 and publishes the session on
 * `res.locals.session` for handlers further down the chain.
 *
 * readSession collapses every failure into null, so there's one 401 body here
 * whether the cookie was missing, forged, or just expired.
 */
export function requireAuth(sessionSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = readSession(req, sessionSecret);
    if (session === null) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    res.locals.session = session;
    next();
  };
}

/**
 * requireAuth plus a check of the Seerr admin bit. 401 when there's no valid
 * session, 403 when there is one and it isn't an admin.
 *
 * Since permissions are copied into the cookie at login, an admin bit revoked
 * in Seerr stays effective here until that session expires or the user signs in
 * again.
 */
export function requireAdmin(sessionSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Delegate to requireAuth and use its `next` callback as the continuation.
    // If auth fails it has already sent the 401 and never calls back, so the
    // admin check below only ever runs against a verified session. The cast is
    // needed because res.locals is typed as `any` by Express.
    requireAuth(sessionSecret)(req, res, () => {
      const session = res.locals.session as SessionPayload | undefined;
      if (!session || !isAdmin(session.permissions)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      next();
    });
  };
}
