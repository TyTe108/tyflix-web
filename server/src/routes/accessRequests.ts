import { Router } from "express";
import {
  normalizeEmail,
  type AccessRequestStore,
  type NewAccessRequestInput,
} from "../accessRequests/store";

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

function isHoneypotTripped(body: unknown): boolean {
  if (body === null || typeof body !== "object") {
    return false;
  }
  const website = (body as { website?: unknown }).website;
  return typeof website === "string" && website.trim() !== "";
}

type ParsedSubmit = Omit<NewAccessRequestInput, "sourceIp">;

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
