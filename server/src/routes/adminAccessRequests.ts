// The approval side of self-serve access requests. Mounted at
// /api/admin/access-requests, and only when ACCESS_REQUESTS_FILE is configured.
// Five endpoints:
//
//   GET  /             the queue, reconciled against Plex
//   GET  /count        pending count for the nav badge
//   GET  /sections     libraries that can be shared
//   POST /:id/approve  invite the applicant to the Plex server
//   POST /:id/deny     reject, with an optional note
//
// index.ts mounts this ahead of /api/admin, and because it's more specific it
// doesn't inherit that mount's requireAdmin. So each route applies its own
// `admin` guard instead. Miss one and it's public.
//
// Approving isn't bookkeeping. It POSTs to plex.tv's sharing API and sends a
// real invitation email, which is why the guard placement matters and why the
// route refuses to touch the store if the Plex call fails.
//
// Reading is a reconcile, not just a list. Invites get accepted out of band,
// through the email or the Plex app, and nothing calls back here when that
// happens. Rather than let rows sit forever saying "invited", GET / compares
// them against plex.tv's pending and shared lists and promotes the ones that
// went through. Plex results are cached for a minute so the admin page can poll.
//
// Upstreams: plex.tv sharing (through PlexSharingClient, which also hits the
// local PMS for its machine id) plus the JSON-file store. No Seerr, no TMDB.

import { Router } from "express";
import {
  AccessRequestTransitionError,
  normalizeEmail,
  type AccessRequest,
  type AccessRequestStore,
} from "../accessRequests/store";
import { requireAdmin } from "../middleware/auth";
import {
  PlexSharingError,
  type InviteResult,
  type PendingInvite,
  type PlexSharingClient,
  type ShareableSection,
  type SharedServerShare,
} from "../plex/sharing";
import type { SeerrClient } from "../seerr/client";
import type { SessionRevocationStore } from "../sessionRevocation";

// How long a Plex pending/shares snapshot is reused. The admin page polls, and
// shares change on human timescales, so a minute is plenty.
const RECONCILE_TTL_MS = 60_000;

// A stored row as the admin UI sees it. Same shape as the persisted record plus
// anything derived at read time.
export type AccessRequestView = AccessRequest & {
  /** Derived only: invite not found in Plex pending or shares. Not persisted. */
  plexInviteMissing?: boolean;
};

export type AccessRequestsListResponse = {
  requests: AccessRequestView[];
  /** Epoch seconds when Plex was successfully consulted; null if unreachable. */
  reconciledAt: number | null;
};

// Narrowed to the exact store and sharing methods this router uses, which is
// what lets the tests hand over small fakes instead of whole clients.
export type AdminAccessRequestsRouterDeps = {
  store: Pick<
    AccessRequestStore,
    "list" | "findById" | "markInvited" | "markDenied" | "markAccepted"
  >;
  sharing: Pick<
    PlexSharingClient,
    | "listShareableSections"
    | "inviteToServer"
    | "listPendingInvites"
    | "listShares"
  >;
  sessionSecret: string;
  seerr: Pick<SeerrClient, "getUserById">;
  sessionRevocation: Pick<SessionRevocationStore, "isRevoked">;
};

// Plex's view of who's been invited and who's accepted, flattened into two
// email-keyed lookups. Keys run through normalizeEmail on both sides of the
// comparison so casing and stray whitespace can't cause a false miss.
type PlexReconcileSnapshot = {
  pendingEmails: Set<string>;
  /** normalized email → acceptedAt from shared_servers (null if attribute missing) */
  acceptedByEmail: Map<string, number | null>;
};

export function createAdminAccessRequestsRouter(
  deps: AdminAccessRequestsRouterDeps,
): Router {
  const { store, sharing, sessionSecret, seerr, sessionRevocation } = deps;
  const router = Router();
  const admin = requireAdmin(sessionSecret, seerr, sessionRevocation);

  // Cleared on approve, since an invite has just changed the state this holds.
  let plexCache: {
    expiresAt: number;
    value: PlexReconcileSnapshot;
  } | null = null;

  // Returns the cached Plex snapshot or fetches a fresh one. Throws whatever the
  // sharing client throws; the caller decides how soft to fail.
  async function loadPlexSnapshot(): Promise<PlexReconcileSnapshot> {
    const now = Date.now();
    if (plexCache !== null && plexCache.expiresAt > now) {
      return plexCache.value;
    }

    // Pending invites and accepted shares live at different plex.tv endpoints
    // and neither depends on the other, so fetch both at once.
    const [pending, shares] = await Promise.all([
      sharing.listPendingInvites(),
      sharing.listShares(),
    ]);

    const value = buildSnapshot(pending, shares);
    plexCache = { value, expiresAt: now + RECONCILE_TTL_MS };
    return value;
  }

  /**
   * GET /api/admin/access-requests
   *
   * The whole queue plus a reconcile pass, as
   * `{ requests, reconciledAt }`. No params. 401 without a session, 403 for
   * non-admins.
   *
   * `reconciledAt` is epoch seconds, or null when Plex couldn't be reached, so
   * the UI can say "as of a minute ago" versus "couldn't check". Rows Plex has
   * accepted get promoted in the store as a side effect of reading, and rows
   * that have vanished from both Plex lists come back flagged
   * `plexInviteMissing`.
   */
  router.get("/", admin, async (_req, res) => {
    res.json(await listWithReconciliation());
  });

  /**
   * GET /api/admin/access-requests/count
   *
   * `{ pending }`, and nothing else. This is what the Admin nav badge polls, so
   * it reads the store only and never touches Plex. 401 without a session,
   * 403 for non-admins.
   */
  router.get("/count", admin, (_req, res) => {
    // Cheap poll target for the Admin nav badge — store only, no Plex.
    const pending = store
      .list()
      .filter((row) => row.status === "pending").length;
    res.json({ pending });
  });

  /**
   * GET /api/admin/access-requests/sections
   *
   * The libraries that can be shared, so the approve dialog can offer
   * checkboxes. 401 without a session, 403 for non-admins, and a Plex failure
   * comes back with plex.tv's own status when there is one, otherwise 502.
   *
   * The `id` on each section is the plex.tv sharing id, which is not the local
   * PMS section key. Approve wants the former.
   */
  router.get("/sections", admin, async (_req, res) => {
    try {
      res.json(await sharing.listShareableSections());
    } catch (err) {
      respondSharingError(res, err);
    }
  });

  /**
   * POST /api/admin/access-requests/:id/approve
   *
   * Sends the applicant a real Plex library invite, then records it. Body is
   * optional: `sectionIds` picks which libraries to share, and leaving it out
   * shares everything currently shareable.
   *
   * 200 with the updated row on success. 400 for a blank id or a sectionIds
   * array that's malformed or names a section Plex won't share, 404 for an
   * unknown id, 409 if the row isn't pending, 500 when Plex accepted the invite
   * but the store write failed, 502 when there are no shareable sections at
   * all. Sharing errors carry plex.tv's status where one exists.
   *
   * Ordering is deliberate: validate, invite, then write. If the invite throws,
   * the row stays pending and the admin can just click again.
   *
   * Plex reads an empty section list as "share all libraries", so an empty
   * shareable list is refused outright rather than risked.
   */
  router.post("/:id/approve", admin, async (req, res) => {
    const id = req.params.id;
    if (typeof id !== "string" || id.trim() === "") {
      res.status(400).json({ error: "id is required" });
      return;
    }

    const record = store.findById(id);
    if (record === undefined) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (record.status !== "pending") {
      res.status(409).json({ error: "request is not pending" });
      return;
    }

    // Pull the live section list before trusting anything in the body. It's
    // both the default (share everything) and the allowlist for an explicit
    // selection, so a stale id from the admin's browser can't leak a library.
    let sections: ShareableSection[];
    try {
      sections = await sharing.listShareableSections();
    } catch (err) {
      respondSharingError(res, err);
      return;
    }

    const allowedIds = new Set(sections.map((s) => s.id));
    // Empty sectionIds means "all libraries" to Plex — never send that by accident.
    if (allowedIds.size === 0) {
      res.status(502).json({ error: "no shareable sections available" });
      return;
    }

    const parsedIds = parseSectionIdsBody(req.body, allowedIds);
    if ("error" in parsedIds) {
      res.status(400).json({ error: parsedIds.error });
      return;
    }
    const sectionIds = parsedIds.sectionIds;

    // The irreversible step. Everything above this line is checks; below it,
    // an email has gone out.
    let inviteResult: InviteResult;
    try {
      inviteResult = await sharing.inviteToServer({
        email: record.email,
        sectionIds,
      });
    } catch (err) {
      // Do not mutate the store — the row stays pending for retry.
      respondSharingError(res, err);
      return;
    }

    // Invite changed plex.tv state (or alreadyShared means our snapshot was
    // stale). Drop the reconcile cache so the next list read re-fetches.
    plexCache = null;

    // "Already shared" isn't a failure. Plex says the user has access, which is
    // the outcome we wanted, so the row still flips to invited and just carries
    // a note explaining why no new email went out.
    const invitedAt = Math.floor(Date.now() / 1000);
    const alreadyShared = inviteResult.ok === false;
    // Dual-write limitation: if Plex accepted the invite and markInvited then
    // fails, an invite exists that we did not record. Log loudly; reconciliation
    // against listShares/listPendingInvites is the recovery.
    try {
      const updated = await store.markInvited(id, {
        sectionIds,
        invitedAt,
        ...(alreadyShared
          ? {
              adminNote:
                "Already shared with this user on Plex at approval time.",
            }
          : {}),
      });
      res.json(updated);
    } catch (err) {
      if (err instanceof AccessRequestTransitionError) {
        res.status(409).json({ error: "request is not pending" });
        return;
      }
      console.error(
        `access request ${id}: Plex invite succeeded but store markInvited failed`,
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({ error: "failed to record invite" });
    }
  });

  /**
   * POST /api/admin/access-requests/:id/deny
   *
   * Marks a pending row denied. Optional body field `adminNote`, capped at 280
   * characters, for a private reason.
   *
   * 200 with the updated row. 400 for a blank id or a bad note, 404 for an
   * unknown id, 409 if the row isn't pending, 500 if the store write fails.
   *
   * Plex is never contacted here. A denial is purely local, and the store lets
   * the same email apply again after 90 days, so a no isn't permanent.
   */
  router.post("/:id/deny", admin, async (req, res) => {
    const id = req.params.id;
    if (typeof id !== "string" || id.trim() === "") {
      res.status(400).json({ error: "id is required" });
      return;
    }

    const record = store.findById(id);
    if (record === undefined) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (record.status !== "pending") {
      res.status(409).json({ error: "request is not pending" });
      return;
    }

    const parsedNote = parseAdminNote(req.body);
    if ("error" in parsedNote) {
      res.status(400).json({ error: parsedNote.error });
      return;
    }

    try {
      const updated = await store.markDenied(id, {
        ...(parsedNote.adminNote !== undefined
          ? { adminNote: parsedNote.adminNote }
          : {}),
      });
      res.json(updated);
    } catch (err) {
      if (err instanceof AccessRequestTransitionError) {
        res.status(409).json({ error: "request is not pending" });
        return;
      }
      console.error(
        err instanceof Error ? err.message : "failed to deny access request",
      );
      res.status(500).json({ error: "failed to deny request" });
    }
  });

  // Builds the GET / payload. Reads the store, then decides per row whether
  // Plex has moved on without telling us. Only "invited" rows are interesting:
  // pending hasn't been sent yet, denied is local, accepted is already settled.
  async function listWithReconciliation(): Promise<AccessRequestsListResponse> {
    const rows = store.list();
    const invited = rows.filter((r) => r.status === "invited");

    // Nothing to reconcile — do not pay for Plex calls.
    if (invited.length === 0) {
      return {
        requests: rows.map((r) => toView(r)),
        reconciledAt: Math.floor(Date.now() / 1000),
      };
    }

    let snapshot: PlexReconcileSnapshot;
    try {
      snapshot = await loadPlexSnapshot();
    } catch (err) {
      // Fail soft: never treat a Plex blip as "email not found".
      console.error(
        err instanceof Error
          ? err.message
          : "access-request reconciliation failed",
      );
      return {
        requests: rows.map((r) => toView(r)),
        reconciledAt: null,
      };
    }

    // Three outcomes per invited row: Plex shows it accepted (promote it and
    // persist that), Plex still lists it as pending (leave it), or Plex has
    // never heard of it (flag it, but don't touch the stored status).
    const views: AccessRequestView[] = [];
    for (const row of rows) {
      if (row.status !== "invited") {
        views.push(toView(row));
        continue;
      }

      const email = normalizeEmail(row.email);
      if (snapshot.acceptedByEmail.has(email)) {
        // The map value is null when the share row had no usable acceptedAt,
        // so fall back to now. That date is approximate; the status isn't.
        const acceptedAt =
          snapshot.acceptedByEmail.get(email) ??
          Math.floor(Date.now() / 1000);
        try {
          const updated = await store.markAccepted(row.id, { acceptedAt });
          views.push(toView(updated));
        } catch (err) {
          console.error(
            `access request ${row.id}: markAccepted failed during reconcile`,
            err instanceof Error ? err.message : err,
          );
          views.push(toView(row));
        }
        continue;
      }

      if (snapshot.pendingEmails.has(email)) {
        views.push(toView(row));
        continue;
      }

      views.push({ ...toView(row), plexInviteMissing: true });
    }

    return {
      requests: views,
      reconciledAt: Math.floor(Date.now() / 1000),
    };
  }

  return router;
}

// Turns the two plex.tv lists into email-keyed lookups. Everything is
// normalized on the way in so the comparison in listWithReconciliation is a
// straight map hit.
function buildSnapshot(
  pending: PendingInvite[],
  shares: SharedServerShare[],
): PlexReconcileSnapshot {
  const pendingEmails = new Set<string>();
  for (const invite of pending) {
    pendingEmails.add(normalizeEmail(invite.email));
  }

  const acceptedByEmail = new Map<string, number | null>();
  for (const share of shares) {
    acceptedByEmail.set(normalizeEmail(share.email), share.acceptedAt);
  }

  return { pendingEmails, acceptedByEmail };
}

// Shallow copy of a stored row for the response. The reconcile pass layers
// derived fields like plexInviteMissing on top, and copying first keeps those
// out of the store's in-memory records.
function toView(row: AccessRequest): AccessRequestView {
  return { ...row };
}

// Reads the optional sectionIds from an approve body. Missing body or missing
// field means every shareable section. An explicit array must be non-empty
// (Plex reads empty as "all") and every id has to be in the live allowlist.
function parseSectionIdsBody(
  body: unknown,
  allowedIds: Set<number>,
): { sectionIds: number[] } | { error: string } {
  if (body === null || typeof body !== "object") {
    return { sectionIds: [...allowedIds] };
  }
  const raw = (body as { sectionIds?: unknown }).sectionIds;
  if (raw === undefined) {
    return { sectionIds: [...allowedIds] };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "sectionIds must be a non-empty array of integers" };
  }
  const sectionIds: number[] = [];
  for (const value of raw) {
    if (!Number.isInteger(value)) {
      return { error: "sectionIds must be a non-empty array of integers" };
    }
    if (!allowedIds.has(value)) {
      return { error: `section id ${value} is not shareable` };
    }
    sectionIds.push(value);
  }
  return { sectionIds };
}

const ADMIN_NOTE_MAX = 280;

// Reads the optional adminNote from a deny body. Absent is fine and leaves the
// existing note alone; present but not a string, or too long, is a 400.
function parseAdminNote(
  body: unknown,
): { adminNote?: string } | { error: string } {
  if (body === null || typeof body !== "object") {
    return {};
  }
  const raw = (body as { adminNote?: unknown }).adminNote;
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== "string") {
    return { error: "adminNote must be a string" };
  }
  if (raw.length > ADMIN_NOTE_MAX) {
    return {
      error: `adminNote must be at most ${ADMIN_NOTE_MAX} characters`,
    };
  }
  return { adminNote: raw };
}

// Unlike the other routers, this one forwards the status carried on a
// PlexSharingError, so a 400 out of section validation or a 401 from plex.tv
// reaches the caller as itself. Anything untyped still becomes a 502.
function respondSharingError(
  res: import("express").Response,
  err: unknown,
): void {
  if (err instanceof PlexSharingError) {
    console.error(err.message);
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message =
    err instanceof Error ? err.message : "Plex sharing request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
