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

const RECONCILE_TTL_MS = 60_000;

export type AccessRequestView = AccessRequest & {
  /** Derived only: invite not found in Plex pending or shares. Not persisted. */
  plexInviteMissing?: boolean;
};

export type AccessRequestsListResponse = {
  requests: AccessRequestView[];
  /** Epoch seconds when Plex was successfully consulted; null if unreachable. */
  reconciledAt: number | null;
};

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
};

type PlexReconcileSnapshot = {
  pendingEmails: Set<string>;
  /** normalized email → acceptedAt from shared_servers (null if attribute missing) */
  acceptedByEmail: Map<string, number | null>;
};

export function createAdminAccessRequestsRouter(
  deps: AdminAccessRequestsRouterDeps,
): Router {
  const { store, sharing, sessionSecret } = deps;
  const router = Router();
  const admin = requireAdmin(sessionSecret);

  let plexCache: {
    expiresAt: number;
    value: PlexReconcileSnapshot;
  } | null = null;

  async function loadPlexSnapshot(): Promise<PlexReconcileSnapshot> {
    const now = Date.now();
    if (plexCache !== null && plexCache.expiresAt > now) {
      return plexCache.value;
    }

    const [pending, shares] = await Promise.all([
      sharing.listPendingInvites(),
      sharing.listShares(),
    ]);

    const value = buildSnapshot(pending, shares);
    plexCache = { value, expiresAt: now + RECONCILE_TTL_MS };
    return value;
  }

  router.get("/", admin, async (_req, res) => {
    res.json(await listWithReconciliation());
  });

  router.get("/count", admin, (_req, res) => {
    // Cheap poll target for the Admin nav badge — store only, no Plex.
    const pending = store
      .list()
      .filter((row) => row.status === "pending").length;
    res.json({ pending });
  });

  router.get("/sections", admin, async (_req, res) => {
    try {
      res.json(await sharing.listShareableSections());
    } catch (err) {
      respondSharingError(res, err);
    }
  });

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

    const adminNote = parseAdminNote(req.body);

    try {
      const updated = await store.markDenied(id, {
        ...(adminNote !== undefined ? { adminNote } : {}),
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

    const views: AccessRequestView[] = [];
    for (const row of rows) {
      if (row.status !== "invited") {
        views.push(toView(row));
        continue;
      }

      const email = normalizeEmail(row.email);
      if (snapshot.acceptedByEmail.has(email)) {
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

function toView(row: AccessRequest): AccessRequestView {
  return { ...row };
}

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

function parseAdminNote(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") {
    return undefined;
  }
  const raw = (body as { adminNote?: unknown }).adminNote;
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  return raw;
}

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
