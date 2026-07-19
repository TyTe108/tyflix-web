import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Request, Response } from "express";

export const SESSION_COOKIE_NAME = "tyflix_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_MAX_AGE_MS = SESSION_TTL_SECONDS * 1000;
export const SEERR_ADMIN_BIT = 2;

// AES-256-GCM parameters for the encrypted Plex-token blob. The key is derived
// from the session secret via HKDF so no new env var/config is introduced.
const TOKEN_KEY_INFO = "tyflix-session-plex-token-v1";
const TOKEN_KEY_BYTES = 32;
const TOKEN_IV_BYTES = 12;
const TOKEN_TAG_BYTES = 16;

export type SessionPayload = {
  seerrUserId: number;
  plexId: number;
  plexUsername: string;
  displayName: string;
  avatar: string | null;
  permissions: number;
  iat: number;
  exp: number;
  // Encrypted (AES-256-GCM) Plex auth token blob. Absent on sessions issued
  // before token capture existed. Never contains plaintext; recover it only
  // through readPlexToken.
  enc?: string;
};

// Identity fields callers supply to issueSession, plus the plaintext Plex token
// to be encrypted internally. plexToken is intentionally kept off SessionPayload
// so it can never be serialized into a response.
export type IssueSessionData = Omit<
  SessionPayload,
  "iat" | "exp" | "enc"
> & {
  plexToken?: string | null;
};

export type SessionCookieOptions = {
  secret: string;
  secure: boolean;
};

// Thrown when a session carries a token blob that is present but cannot be
// authenticated/decrypted (corrupt or tampered). Distinct from the legitimate
// "no token present" case, which returns null.
export class TokenDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TokenDecryptError";
  }
}

export function isAdmin(permissions: number): boolean {
  return (permissions & SEERR_ADMIN_BIT) !== 0;
}

export function issueSession(
  res: Response,
  data: IssueSessionData,
  options: SessionCookieOptions,
): SessionPayload {
  const { plexToken, ...identity } = data;
  const iat = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    ...identity,
    iat,
    exp: iat + SESSION_TTL_SECONDS,
  };
  // Fail loud: if a token was supplied but encryption fails, throw rather than
  // silently issuing a tokenless session.
  if (plexToken !== undefined && plexToken !== null && plexToken !== "") {
    payload.enc = encryptPlexToken(plexToken, options.secret);
  }
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

// Recovers the plaintext Plex token from a verified session. Returns null when
// the session predates token capture (no blob). Throws TokenDecryptError when a
// blob is present but fails authentication/decryption.
export function readPlexToken(
  session: SessionPayload,
  secret: string,
): string | null {
  const blob = session.enc;
  if (blob === undefined || blob === null || blob === "") {
    return null;
  }

  const raw = Buffer.from(blob, "base64url");
  if (raw.length <= TOKEN_IV_BYTES + TOKEN_TAG_BYTES) {
    throw new TokenDecryptError("token blob is too short to be valid");
  }

  const iv = raw.subarray(0, TOKEN_IV_BYTES);
  const tag = raw.subarray(TOKEN_IV_BYTES, TOKEN_IV_BYTES + TOKEN_TAG_BYTES);
  const ciphertext = raw.subarray(TOKEN_IV_BYTES + TOKEN_TAG_BYTES);

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveTokenKey(secret),
      iv,
    );
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch (err) {
    throw new TokenDecryptError("failed to decrypt Plex token", { cause: err });
  }
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

function deriveTokenKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.alloc(0),
      Buffer.from(TOKEN_KEY_INFO, "utf8"),
      TOKEN_KEY_BYTES,
    ),
  );
}

function encryptPlexToken(token: string, secret: string): string {
  const iv = randomBytes(TOKEN_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveTokenKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
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
    typeof v.exp === "number" &&
    (v.enc === undefined || typeof v.enc === "string")
  );
}
