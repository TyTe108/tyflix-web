import type { NextFunction, Request, Response } from "express";
import { isAdmin, readSession, type SessionPayload } from "../session";

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

export function requireAdmin(sessionSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
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
