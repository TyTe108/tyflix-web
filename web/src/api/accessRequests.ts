// Self-serve access requests: a stranger asks for an account, an admin approves
// it, and Plex sends a real library invite. This file talks to two different
// server routers, which is unusual for api/ and worth knowing up front:
//
//   submitAccessRequest      -> POST /api/access-requests
//                               server/src/routes/accessRequests.ts, public
//   everything else          -> /api/admin/access-requests/*
//                               server/src/routes/adminAccessRequests.ts, admin
//
// The public submit is the only unauthenticated write path in the whole app. It
// has to be, since the people using it don't have accounts yet. There's no
// CAPTCHA. A hidden `website` honeypot field plus a 5-per-hour per-IP cap
// handle crawlers, and an abusive submission is inert anyway because nothing
// happens until an admin approves it.
//
// Approving is not bookkeeping. It calls plex.tv's sharing API and an
// invitation email goes out, so approveAccessRequest is a genuinely
// irreversible click.
//
// Both routers answer failures with a JSON `{ error }` body. The admin helpers
// read that back out through errorMessage() at the bottom and throw it; the
// public submit doesn't throw at all. See below for why.
//
// Whether any of this is mounted depends on the ACCESS_REQUESTS_FILE env var on
// the server. /api/config reports that as a flag, and useAccessRequestsEnabled
// is what the UI gates its links on.

// What the request-access wizard posts. `website` is the honeypot: the real
// form keeps it off-screen and empty, so anything in it means a bot filled the
// page in.
export type AccessRequestInput = {
  email: string;
  name: string;
  note: string;
  hasPlexAccount: boolean;
  plexUsername?: string;
  website: string;
};

// The lifecycle of a request. pending is waiting on an admin, invited means the
// Plex email went out, accepted means the person actually joined, and denied is
// purely local (Plex is never told). The server lets a denied email reapply
// after 90 days, so a no isn't permanent.
export type AccessRequestStatus =
  | "pending"
  | "invited"
  | "accepted"
  | "denied";

// A stored row, exactly as the server persists it. Timestamps are epoch
// seconds, and each of the three optional ones is null until that transition
// happens. sourceIp is stamped from CF-Connecting-IP, not from anything the
// submitter can set.
export type AccessRequest = {
  id: string;
  email: string;
  plexUsername: string | null;
  name: string;
  note: string;
  hasPlexAccount: boolean;
  status: AccessRequestStatus;
  createdAt: number;
  decidedAt: number | null;
  invitedAt: number | null;
  acceptedAt: number | null;
  sectionIds: number[] | null;
  adminNote: string | null;
  sourceIp: string | null;
};

/** List row from GET /api/admin/access-requests after reconciliation. */
export type AccessRequestView = AccessRequest & {
  // Derived at read time, never persisted: the row says "invited" but Plex has
  // it in neither its pending nor its shared list. Usually means the invite was
  // revoked or expired on Plex's side.
  plexInviteMissing?: boolean;
};

// Reading the queue also reconciles it against Plex, because invites get
// accepted out of band and nothing calls back here when that happens. Rows Plex
// shows as accepted get promoted as a side effect of this read.
export type AccessRequestsListResponse = {
  requests: AccessRequestView[];
  // Epoch seconds, or null when Plex couldn't be reached. That distinction lets
  // the UI say "as of a minute ago" versus "couldn't check", instead of quietly
  // showing stale statuses as if they were fresh.
  reconciledAt: number | null;
};

// A library the owner can share. `id` is the plex.tv sharing id and it's what
// approve wants; `key` is the local PMS section key and is not interchangeable
// with it.
export type ShareableSection = {
  id: number;
  key: number;
  title: string;
  type: string;
};

// Result of the public submit, as a discriminated union rather than a throw.
// The wizard renders validation and rate-limit cases inline in the form, and
// only "error" gets the generic try-again treatment.
export type SubmitAccessRequestResult =
  | { ok: true }
  | { ok: false; kind: "validation"; message: string }
  | { ok: false; kind: "rateLimited" }
  | { ok: false; kind: "error"; message: string };

/**
 * POST /api/access-requests. Does not throw on 400/429 — those are returned as
 * discriminated results so the wizard can render them inline. A network failure
 * is caught too, so this never rejects.
 *
 * A success here is a 202, not a 201. Nothing has been granted yet; the row
 * just exists and waits for a human.
 *
 * Worth knowing before you try to build a smarter UI on top of this: the server
 * returns the exact same 202 for a real submission, a honeypot trip, and a
 * duplicate email. That's deliberate, so nobody can use the response to work
 * out who's already applied or which field gave them away. The client can't
 * tell those three apart either, and shouldn't try.
 */
export async function submitAccessRequest(
  input: AccessRequestInput,
): Promise<SubmitAccessRequestResult> {
  let res: Response;
  try {
    res = await fetch("/api/access-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    return {
      ok: false,
      kind: "error",
      message: "Network error. Please try again.",
    };
  }

  if (res.status === 202) {
    try {
      const body: unknown = await res.json();
      if (
        typeof body === "object" &&
        body !== null &&
        (body as { status?: unknown }).status === "received"
      ) {
        return { ok: true };
      }
    } catch {
      // fall through
    }
    return {
      ok: false,
      kind: "error",
      message: "Unexpected response from server. Please try again.",
    };
  }

  if (res.status === 400) {
    try {
      const body = (await res.json()) as { error?: unknown };
      const message =
        typeof body.error === "string" && body.error.trim() !== ""
          ? body.error
          : "Invalid request.";
      return { ok: false, kind: "validation", message };
    } catch {
      return {
        ok: false,
        kind: "error",
        message: "Unexpected response from server. Please try again.",
      };
    }
  }

  if (res.status === 429) {
    return { ok: false, kind: "rateLimited" };
  }

  return {
    ok: false,
    kind: "error",
    message: `Request failed (${res.status}). Please try again.`,
  };
}

/**
 * GET /api/admin/access-requests. The whole queue, plus a reconcile pass
 * against Plex.
 *
 * Reading has side effects on the server: rows Plex reports as accepted get
 * promoted in the store while this call runs.
 *
 * @throws Error with the server's `{ error }` message, or the status code when
 * there isn't one.
 */
export async function fetchAccessRequests(): Promise<AccessRequestsListResponse> {
  const res = await fetch("/api/admin/access-requests");
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load access requests"));
  }
  return (await res.json()) as AccessRequestsListResponse;
}

/**
 * GET /api/admin/access-requests/sections. The libraries the approve dialog can
 * offer as checkboxes.
 *
 * This one forwards plex.tv's own status on failure rather than flattening
 * everything to 502, so a 401 here really does mean the owner token is bad.
 *
 * @throws Error with the server's `{ error }` message.
 */
export async function fetchAccessRequestSections(): Promise<ShareableSection[]> {
  const res = await fetch("/api/admin/access-requests/sections");
  if (!res.ok) {
    throw new Error(
      await errorMessage(res, "Failed to load shareable sections"),
    );
  }
  return (await res.json()) as ShareableSection[];
}

/**
 * GET /api/admin/access-requests/count. Just the pending number, for the badge
 * on the Admin nav item.
 *
 * Cheap on purpose. AppShell calls it and the server reads only its local store
 * here, never Plex, which is what makes it safe to hit on every mount.
 *
 * @throws Error with the server's `{ error }` message.
 */
export async function fetchAccessRequestPendingCount(): Promise<{
  pending: number;
}> {
  const res = await fetch("/api/admin/access-requests/count");
  if (!res.ok) {
    throw new Error(
      await errorMessage(res, "Failed to load access request count"),
    );
  }
  return (await res.json()) as { pending: number };
}

/**
 * POST /api/admin/access-requests/:id/approve. Sends the applicant a real Plex
 * library invite, then records it. This is the irreversible one.
 *
 * Omitting sectionIds shares every library that's currently shareable. Passing
 * an explicit list narrows it, and the server re-validates each id against the
 * live list, so a stale checkbox in a long-open tab can't leak a library.
 *
 * @throws Error with the server's message. 409 means the row isn't pending any
 * more, usually because it was approved in another tab.
 */
export async function approveAccessRequest(
  id: string,
  sectionIds?: number[],
): Promise<AccessRequest> {
  const res = await fetch(
    `/api/admin/access-requests/${encodeURIComponent(id)}/approve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        sectionIds !== undefined ? { sectionIds } : {},
      ),
    },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to approve access request"));
  }
  return (await res.json()) as AccessRequest;
}

/**
 * POST /api/admin/access-requests/:id/deny. Marks a pending row denied.
 *
 * Nothing reaches Plex and no email goes out. The optional note is private to
 * the admin and capped at 280 characters server-side; a blank one is sent as an
 * empty body so it doesn't overwrite an existing note with "".
 *
 * @throws Error with the server's message.
 */
export async function denyAccessRequest(
  id: string,
  adminNote?: string,
): Promise<AccessRequest> {
  const trimmed = adminNote?.trim() ?? "";
  const res = await fetch(
    `/api/admin/access-requests/${encodeURIComponent(id)}/deny`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trimmed === "" ? {} : { adminNote: trimmed }),
    },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to deny access request"));
  }
  return (await res.json()) as AccessRequest;
}

/**
 * Badge class per status, reusing the request-status palette rather than
 * defining its own. "invited" borrows the processing colour because that's what
 * it is: sent, waiting on the other person.
 */
export function accessRequestStatusBadgeClass(
  status: AccessRequestStatus,
): string {
  switch (status) {
    case "pending":
      return "request-status request-status-pending";
    case "invited":
      return "request-status request-status-processing";
    case "accepted":
      return "request-status request-status-approved";
    case "denied":
      return "request-status request-status-declined";
  }
}

// Prefers the server's `{ error }` text over a generic message, falling back to
// "<fallback> (<status>)". Every admin call in this file throws through here,
// which is what puts "request is not pending" in front of the admin instead of
// a bare 409.
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim() !== "") {
      return body.error;
    }
  } catch {
    // fall through
  }
  return `${fallback} (${res.status})`;
}
