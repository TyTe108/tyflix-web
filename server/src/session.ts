import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

export const SESSION_COOKIE_NAME = "tyflix_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_MAX_AGE_MS = SESSION_TTL_SECONDS * 1000;
export const SEERR_ADMIN_BIT = 2;

export type SessionPayload = {
  seerrUserId: number;
  plexId: number;
  plexUsername: string;
  displayName: string;
  avatar: string | null;
  permissions: number;
  iat: number;
  exp: number;
};

export type SessionCookieOptions = {
  secret: string;
  secure: boolean;
};

export function isAdmin(permissions: number): boolean {
  return (permissions & SEERR_ADMIN_BIT) !== 0;
}

export function issueSession(
  res: Response,
  data: Omit<SessionPayload, "iat" | "exp">,
  options: SessionCookieOptions,
): SessionPayload {
  const iat = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    ...data,
    iat,
    exp: iat + SESSION_TTL_SECONDS,
  };
  const token = signSession(payload, options.secret);
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: options.secure,
    path: "/",
    maxAge: SESSION_MAX_AGE_MS,
  });
  return payload;
}

export function readSession(
  req: Request,
  secret: string,
): SessionPayload | null {
  try {
    const raw = getCookieValue(req.headers.cookie, SESSION_COOKIE_NAME);
    if (raw === null) {
      return null;
    }

    const dot = raw.indexOf(".");
    if (dot <= 0 || dot === raw.length - 1) {
      return null;
    }

    const payloadPart = raw.slice(0, dot);
    const sigPart = raw.slice(dot + 1);

    const json = Buffer.from(payloadPart, "base64url").toString("utf8");
    const expected = createHmac("sha256", secret).update(json).digest();
    const actual = Buffer.from(sigPart, "base64url");

    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      return null;
    }

    const parsed: unknown = JSON.parse(json);
    if (!isSessionPayload(parsed)) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (parsed.exp < now) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(
  res: Response,
  options: Pick<SessionCookieOptions, "secure">,
): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: options.secure,
    path: "/",
  });
}

function signSession(payload: SessionPayload, secret: string): string {
  const json = JSON.stringify(payload);
  const payloadPart = Buffer.from(json, "utf8").toString("base64url");
  const sigPart = createHmac("sha256", secret)
    .update(json)
    .digest("base64url");
  return `${payloadPart}.${sigPart}`;
}

function getCookieValue(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (key !== name) {
      continue;
    }
    return trimmed.slice(eq + 1);
  }
  return null;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.seerrUserId === "number" &&
    typeof v.plexId === "number" &&
    typeof v.plexUsername === "string" &&
    typeof v.displayName === "string" &&
    (v.avatar === null || typeof v.avatar === "string") &&
    typeof v.permissions === "number" &&
    typeof v.iat === "number" &&
    typeof v.exp === "number"
  );
}
