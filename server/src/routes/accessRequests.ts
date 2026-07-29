// The "ask for access" form. Mounted at /api/access-requests with a single
// endpoint, POST /, and it's the only unauthenticated write path in the whole
// app. index.ts only mounts it when ACCESS_REQUESTS_FILE is configured, and it
// puts accessRequestLimiter (5 submissions per hour per IP) in front.
//
// It has to be public, because the people using it don't have accounts yet.
// I skipped the CAPTCHA on purpose. An abusive submission is already inert:
// nothing here emails anyone, calls Plex, or creates an account. All it can do
// is append a row that only I ever see, and an admin has to approve it before
// anything real happens. That leaves crawlers, which the honeypot field plus
// the per-IP hourly cap handle without making real people prove they're human.
// The approve side lives in routes/adminAccessRequests.ts.
//
// No upstream services. The only dependency is the JSON-file store.

import { Router } from "express";
import {
  normalizeEmail,
  type AccessRequestStore,
  type NewAccessRequestInput,
} from "../accessRequests/store";

// Length caps on everything a stranger can type. 254 is the RFC ceiling for an
// email address; the rest are just sane limits on a form nobody should be
// writing an essay into.
const EMAIL_MAX = 254;
const NAME_MAX = 80;
const PLEX_USERNAME_MAX = 64;
const NOTE_MAX = 280;

/** Basic shape: local@domain with at least one dot in the domain. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AccessRequestsRouterDeps = {
  store: Pick<AccessRequestStore, "findByEmail" | "add">;
};

export function createAccessRequestsRouter(
  deps: AccessRequestsRouterDeps,
): Router {
  const { store } = deps;
  const router = Router();

  /**
   * POST /api/access-requests
   *
   * Body: `email`, `name`, `note`, `hasPlexAccount` (all required), optional
   * `plexUsername`, plus the `website` honeypot the real form leaves empty.
   *
   * 202 `{ status: "received" }` on success, and also on a honeypot trip or a
   * duplicate email. Those three cases are byte-identical by design, so nobody
   * can use the response to work out who has already applied or which field
   * gave them away. 400 lists the first validation failure, 500 means the store
   * write failed.
   *
   * Note the 202 rather than 201. Nothing has been granted at this point; the
   * row just exists and waits for an admin.
   */
  router.post("/", async (req, res) => {
    // Honeypot: bots fill `website`; humans leave it empty. Same 202 as a
    // real submit so the field cannot be used as an oracle.
    if (isHoneypotTripped(req.body)) {
      res.status(202).json({ status: "received" });
      return;
    }

    const parsed = parseSubmitBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    // Idempotent by email: duplicate submits get the same 202 and no new row,
    // so the endpoint cannot be used to discover who has already applied.
    if (store.findByEmail(parsed.email) !== undefined) {
      res.status(202).json({ status: "received" });
      return;
    }

    // Stamp the row with the real client IP so a flood is traceable after the
    // fact. Behind the tunnel req.ip is always the container's peer, so the
    // Cloudflare header is the only useful value in production.
    const sourceIp = clientIp(req.headers["cf-connecting-ip"], req.ip);

    try {
      await store.add({
        email: parsed.email,
        name: parsed.name,
        note: parsed.note,
        hasPlexAccount: parsed.hasPlexAccount,
        ...(parsed.plexUsername !== undefined
          ? { plexUsername: parsed.plexUsername }
          : {}),
        sourceIp,
      });
      res.status(202).json({ status: "received" });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "failed to store access request";
      console.error(message);
      res.status(500).json({ error: "failed to store access request" });
    }
  });

  return router;
}

// True when the hidden `website` field came back filled in. The real form keeps
// it off-screen and empty, so anything in there is an automated submit.
function isHoneypotTripped(body: unknown): boolean {
  if (body === null || typeof body !== "object") {
    return false;
  }
  const website = (body as { website?: unknown }).website;
  return typeof website === "string" && website.trim() !== "";
}

// Everything the route validates out of the body. sourceIp is added afterwards
// from request headers, not from anything the submitter can set.
type ParsedSubmit = Omit<NewAccessRequestInput, "sourceIp">;

// Validates and normalizes the submitted form. Returns the first problem it
// finds rather than collecting them all, since the form validates client-side
// too and this is really the backstop. Email is lowercased and trimmed here so
// the store's uniqueness check sees a canonical value.
function parseSubmitBody(body: unknown): ParsedSubmit | { error: string } {
  if (body === null || typeof body !== "object") {
    return { error: "invalid body" };
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw.email !== "string") {
    return { error: "email is required" };
  }
  const email = normalizeEmail(raw.email);
  if (email === "") {
    return { error: "email is required" };
  }
  if (email.length > EMAIL_MAX) {
    return { error: `email must be at most ${EMAIL_MAX} characters` };
  }
  if (!EMAIL_SHAPE.test(email)) {
    return { error: "email must be a valid email address" };
  }

  if (typeof raw.name !== "string") {
    return { error: "name is required" };
  }
  const name = raw.name.trim();
  if (name === "") {
    return { error: "name is required" };
  }
  if (name.length > NAME_MAX) {
    return { error: `name must be at most ${NAME_MAX} characters` };
  }

  if (typeof raw.note !== "string") {
    return { error: "note is required" };
  }
  const note = raw.note.trim();
  if (note === "") {
    return { error: "note is required" };
  }
  if (note.length > NOTE_MAX) {
    return { error: `note must be at most ${NOTE_MAX} characters` };
  }

  if (typeof raw.hasPlexAccount !== "boolean") {
    return { error: "hasPlexAccount must be a boolean" };
  }

  let plexUsername: string | undefined;
  if (raw.plexUsername !== undefined && raw.plexUsername !== null) {
    if (typeof raw.plexUsername !== "string") {
      return { error: "plexUsername must be a string" };
    }
    const trimmed = raw.plexUsername.trim();
    if (trimmed.length > PLEX_USERNAME_MAX) {
      return {
        error: `plexUsername must be at most ${PLEX_USERNAME_MAX} characters`,
      };
    }
    if (trimmed !== "") {
      plexUsername = trimmed;
    }
  }

  return {
    email,
    name,
    note,
    hasPlexAccount: raw.hasPlexAccount,
    ...(plexUsername !== undefined ? { plexUsername } : {}),
  };
}

// Prefers CF-Connecting-IP (Cloudflare sets and overwrites it, so a client
// can't forge it) and falls back to the socket address for local dev. Same
// ordering as the rate limiter's key. Null when neither is usable.
function clientIp(
  header: string | string[] | undefined,
  fallback: string | undefined,
): string | null {
  const cfConnectingIp = Array.isArray(header) ? header[0] : header;
  const fromHeader = cfConnectingIp?.trim();
  if (fromHeader) {
    return fromHeader;
  }
  const fromReq = fallback?.trim();
  return fromReq || null;
}
