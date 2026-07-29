// The session format. Everything about how a logged-in user is represented on
// the wire lives in this one file: the cookie's layout, its signature, and the
// encrypted Plex token carried inside it.
//
// There's no session store. The cookie is the session, and it looks like
// `<base64url(json)>.<base64url(hmac-sha256)>`, signed with SESSION_SECRET. On
// each request readSession recomputes the HMAC over the exact JSON bytes,
// compares in constant time, then checks `exp`. Any failure returns null, which
// middleware/auth.ts turns into a 401. That means a tampered cookie and a
// missing cookie are the same thing to a caller, which is intentional.
//
// The user's long-lived Plex token rides along in the `enc` field, encrypted
// with AES-256-GCM under a key derived from SESSION_SECRET via HKDF-SHA256. So
// the browser holds the token, but only as ciphertext it can't read, and only
// the server can recover it (readPlexToken) to talk to Plex on the user's
// behalf. The signature alone wouldn't be enough here: signing proves the
// payload wasn't altered, it doesn't hide it, and a base64url payload is
// trivially readable in devtools.
//
// One consequence worth knowing before you rotate SESSION_SECRET: it's both the
// HMAC key and the HKDF input. Change it and every outstanding cookie fails its
// signature check, so everyone gets logged out and every stored token blob
// becomes undecryptable. That's the safe direction to fail, but it isn't a
// silent change.
//
// There's no cookie-parser middleware in the app. getCookieValue below reads
// the raw Cookie header, which keeps the whole format contained here.

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
// 30 days. Enforced twice: as `exp` inside the signed payload (server side, the
// one that counts) and as the cookie's maxAge (client side, just tidiness).
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_MAX_AGE_MS = SESSION_TTL_SECONDS * 1000;
// Mirrors Seerr's ADMIN permission flag. The `permissions` number in the
// payload is copied from the Seerr user at login, so admin here means admin
// there.
export const SEERR_ADMIN_BIT = 2;

// AES-256-GCM parameters for the encrypted Plex-token blob. The key is derived
// from the session secret via HKDF so no new env var/config is introduced.
//
// TOKEN_KEY_INFO is the HKDF info string, versioned, so a format change could
// derive a different key from the same secret. 12-byte IV and 16-byte tag are
// the standard GCM sizes; both are read back by offset in readPlexToken, so
// changing either number breaks every blob already issued.
const TOKEN_KEY_INFO = "tyflix-session-plex-token-v1";
const TOKEN_KEY_BYTES = 32;
const TOKEN_IV_BYTES = 12;
const TOKEN_TAG_BYTES = 16;

// What's actually inside the cookie, JSON-serialized and signed. Written by
// issueSession, read back by readSession, and handed to routers as
// res.locals.session. Everything except `enc` is plainly readable by anyone who
// base64-decodes their own cookie, so nothing secret goes in here.
export type SessionPayload = {
  seerrUserId: number;
  plexId: number;
  plexUsername: string;
  displayName: string;
  avatar: string | null;
  // Seerr's permission bitmask, copied at login. Tested against
  // SEERR_ADMIN_BIT. A user promoted in Seerr keeps the old value until they
  // sign in again.
  permissions: number;
  iat: number; // issued at, epoch seconds
  exp: number; // expires at, epoch seconds; readSession rejects anything past it
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
  secure: boolean; // Secure flag on the cookie; false in dev, HTTP has no TLS
};

/**
 * Thrown when a session carries a token blob that is present but cannot be
 * authenticated/decrypted (corrupt or tampered). Distinct from the legitimate
 * "no token present" case, which returns null.
 *
 * Callers in routes/watch.ts and routes/library.ts catch this and answer 502
 * rather than 401, since the session itself verified fine and it's the blob
 * inside that didn't.
 */
export class TokenDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TokenDecryptError";
  }
}

/**
 * Tests the Seerr admin bit in a permission bitmask.
 *
 * The only place admin is decided. Callers are middleware/auth.ts,
 * routes/auth.ts, routes/issues.ts and routes/requests.ts, so there's one
 * definition of the answer.
 */
export function isAdmin(permissions: number): boolean {
  return (permissions & SEERR_ADMIN_BIT) !== 0;
}

/**
 * Mints a session and sets it as the `tyflix_session` cookie.
 *
 * Called from the Plex PIN callback once Seerr has confirmed the user has
 * access. `iat`/`exp` are stamped here rather than passed in, and the Plex
 * token in `data` gets encrypted rather than stored as-is.
 *
 * @returns the payload that was signed, so the caller can respond with the same
 * identity it just issued
 * @throws whatever encryptPlexToken throws when a token was supplied but can't
 * be encrypted. Not caught on purpose, so a tokenless session never gets issued
 * quietly.
 */
export function issueSession(
  res: Response,
  data: IssueSessionData,
  options: SessionCookieOptions,
): SessionPayload {
  // Destructure the token off first. `identity` is then exactly the payload
  // fields, so nothing can accidentally spread a plaintext token into the JSON
  // that gets signed and shipped.
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
  // Sign last, after `enc` is attached, so the signature covers the ciphertext
  // too. httpOnly keeps the cookie away from page scripts, and path "/" covers
  // the API and the SPA alike. clearSession has to mirror these attributes or
  // the browser won't match the cookie it's being asked to delete.
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

/**
 * Recovers the plaintext Plex token from a verified session.
 *
 * This is the only way back to the durable token, and it's server-side only.
 * Pass a session that readSession already verified; this function checks the
 * GCM tag but not the outer HMAC.
 *
 * @returns null when the session predates token capture and carries no blob,
 * which callers have to handle as a normal case
 * @throws TokenDecryptError when a blob is present but fails
 * authentication/decryption, meaning the cookie was tampered with or the
 * session secret changed
 */
export function readPlexToken(
  session: SessionPayload,
  secret: string,
): string | null {
  const blob = session.enc;
  if (blob === undefined || blob === null || blob === "") {
    return null;
  }

  // Blob layout is iv || tag || ciphertext, written by encryptPlexToken below.
  // The length check rejects anything that couldn't even hold a header plus one
  // byte of payload, so the subarray slicing after it can't silently produce
  // empty buffers.
  const raw = Buffer.from(blob, "base64url");
  if (raw.length <= TOKEN_IV_BYTES + TOKEN_TAG_BYTES) {
    throw new TokenDecryptError("token blob is too short to be valid");
  }

  const iv = raw.subarray(0, TOKEN_IV_BYTES);
  const tag = raw.subarray(TOKEN_IV_BYTES, TOKEN_IV_BYTES + TOKEN_TAG_BYTES);
  const ciphertext = raw.subarray(TOKEN_IV_BYTES + TOKEN_TAG_BYTES);

  // setAuthTag before final() is what makes this authenticated: a wrong key or
  // a flipped bit anywhere in the blob makes final() throw instead of handing
  // back garbage. Everything in the try is collapsed into one TokenDecryptError
  // so no detail about why it failed leaks upward.
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

/**
 * Verifies the session cookie on a request and returns the payload it carries.
 *
 * The gate for the whole authenticated API. requireAuth calls it on every
 * guarded route, and /api/auth/me calls it directly.
 *
 * @returns null for every failure mode there is: no cookie, malformed cookie,
 * bad signature, unexpected payload shape, or expired. Callers can't tell them
 * apart, and shouldn't; they all mean "not logged in". Never throws.
 */
export function readSession(
  req: Request,
  secret: string,
): SessionPayload | null {
  // One try/catch around everything. Buffer decoding and JSON.parse both throw
  // on hostile input, and there's no failure in here that deserves a different
  // answer than null.
  try {
    const raw = getCookieValue(req.headers.cookie, SESSION_COOKIE_NAME);
    if (raw === null) {
      return null;
    }

    // Split on the first dot into payload and signature. Rejecting dot at index
    // 0 or at the end catches an empty half before any crypto runs.
    const dot = raw.indexOf(".");
    if (dot <= 0 || dot === raw.length - 1) {
      return null;
    }

    const payloadPart = raw.slice(0, dot);
    const sigPart = raw.slice(dot + 1);

    // HMAC is recomputed over the decoded JSON string, which is the same input
    // signSession used. Compare with timingSafeEqual, and length-check first
    // because timingSafeEqual throws on mismatched lengths rather than
    // returning false.
    const json = Buffer.from(payloadPart, "base64url").toString("utf8");
    const expected = createHmac("sha256", secret).update(json).digest();
    const actual = Buffer.from(sigPart, "base64url");

    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      return null;
    }

    // Signature is good, so this JSON came from us. Shape-check it anyway,
    // because an old cookie signed by the same secret can predate a field the
    // current code expects.
    const parsed: unknown = JSON.parse(json);
    if (!isSessionPayload(parsed)) {
      return null;
    }

    // Expiry is checked server side against the payload's own exp. The cookie's
    // maxAge is only a hint to the browser and a client can ignore it.
    const now = Math.floor(Date.now() / 1000);
    if (parsed.exp < now) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Logs a user out by expiring the session cookie.
 *
 * The attributes here have to match the ones issueSession set, apart from
 * maxAge, or the browser treats it as a different cookie and leaves the real
 * one in place.
 */
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

// HKDF-SHA256 from the session secret to a 32-byte AES key. Empty salt, and the
// versioned info string does the domain separation, so this key is distinct
// from the secret used raw as the HMAC key even though both come from the same
// env var. Derived fresh on every encrypt and decrypt; nothing caches it.
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

// Encrypts the Plex token into the base64url blob that becomes `enc`. Fresh
// random IV per call, which is what keeps GCM safe to reuse the same derived
// key across every session. Output layout is iv || tag || ciphertext, and
// readPlexToken slices it back apart by those fixed lengths.
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

// Serializes and signs the payload into the `<payload>.<signature>` cookie
// value. The HMAC is taken over the JSON string, not the base64url encoding of
// it, so readSession has to decode before it can verify. base64url on both
// halves: no padding, and none of its characters get percent-encoded on the way
// out, which matters because getCookieValue reads the value back raw.
function signSession(payload: SessionPayload, secret: string): string {
  const json = JSON.stringify(payload);
  const payloadPart = Buffer.from(json, "utf8").toString("base64url");
  const sigPart = createHmac("sha256", secret)
    .update(json)
    .digest("base64url");
  return `${payloadPart}.${sigPart}`;
}

// Minimal Cookie-header parser, in place of pulling in cookie-parser for one
// value. Splits on ";", takes the first "=" in each pair as the separator so a
// "=" inside the value survives, and returns the value undecoded because the
// cookie is base64url plus a dot, none of which needs percent-decoding.
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

// Runtime shape check for the parsed JSON, since JSON.parse returns `any` and
// TypeScript can't help past that boundary. Every field is required except
// `enc`, which stays optional so sessions issued before token capture still
// validate. Extra fields are ignored, so adding one to SessionPayload won't
// invalidate cookies already out there, but it also won't be checked here.
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
