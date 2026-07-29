// Client for the server's requests router (server/src/routes/requests.ts),
// mounted at /api/requests behind requireAuth. Creating a request, listing your
// own, and the admin queue with its approve and decline actions.
//
// Tyflix doesn't run the download pipeline. Seerr does, with Radarr and Sonarr
// behind it, so everything here is a thin pass through to Seerr plus a TMDB
// lookup for the title and poster (Seerr's rows only carry ids). The point of
// the whole feature was that nobody in the house should have to open Radarr.
//
// Four of the six endpoints are admin-only server-side: /profiles, /all, and
// both actions. The UI hides them from everyone else, but the 403 is what
// actually enforces it.
//
// Errors follow the api/discover.ts convention, throw on non-2xx with the
// status code, except createRequest which returns a result union. This file
// also owns MediaAvailabilityStatus, imported by api/discover.ts,
// api/watchlist.ts and components/MediaCard.tsx.

import type { MediaType } from "./discover";

// Where a request sits with the approver. Orthogonal to whether the file has
// actually arrived, which is what MediaAvailabilityStatus tracks. A request can
// be "approved" while the media is still "processing".
export type RequestApprovalStatus =
  | "pending"
  | "approved"
  | "declined"
  | "failed"
  | "completed";

// Seerr's view of whether the title is on the Plex server. This is the type
// that gets stamped onto every discovery row as `mediaStatus`, and it's the
// TMDB-to-Plex join showing through. "unknown" means Seerr tracks the title but
// has nothing on disk for it.
export type MediaAvailabilityStatus =
  | "unknown"
  | "pending"
  | "processing"
  | "partially_available"
  | "available"
  | "blocklisted"
  | "deleted";

// One request row, already enriched server-side with the TMDB title and poster.
// `seasons` is empty for movies. Both timestamps are ISO strings from Seerr.
export type RequestView = {
  id: number;
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  posterUrl: string | null;
  seasons: number[];
  requestStatus: RequestApprovalStatus;
  mediaStatus: MediaAvailabilityStatus;
  requestedById: number;
  requestedByName: string;
  createdAt: string;
  updatedAt: string;
};

// Body for POST /. Omitting `seasons` on a show means the whole thing.
// `profileId` is a quality override and the server 403s a non-admin who sends
// it, so the dialog only offers that control to admins.
export type CreateRequestInput = {
  tmdbId: number;
  mediaType: MediaType;
  seasons?: number[];
  profileId?: number;
};

// Radarr or Sonarr quality profiles as Seerr reports them. `serverId` matters
// because Seerr won't take a profileId without knowing which server it belongs
// to, though the frontend never has to pair them itself.
export type RequestProfiles = {
  serverId: number;
  defaultProfileId: number;
  profiles: Array<{ id: number; name: string }>;
};

export type CreateRequestResult =
  | { ok: true; request: RequestView }
  | { ok: false; alreadyRequested: true; request: RequestView };

/**
 * POST /api/requests. Sends a title into the Seerr pipeline, attributed to the
 * signed-in user rather than to the API key's owner, which is what keeps quotas
 * and auto-approve rules pointed at the right person.
 *
 * @throws Error on any non-2xx, and on a duplicate. See the note below about
 * the 409 path.
 */
export async function createRequest(
  input: CreateRequestInput,
): Promise<CreateRequestResult> {
  const res = await fetch("/api/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  // Seerr's "you already asked for this" comes back as a 409.
  //
  // NOTE: the server's 409 body is `{ error: "already requested" }` with no
  // `request` field (server/src/routes/requests.ts), so `body.request` is
  // always undefined and this always falls through to the throw. That makes
  // the `{ ok: false, alreadyRequested: true }` arm of CreateRequestResult
  // unreachable as things stand. Leaving it alone, flagged rather than fixed.
  if (res.status === 409) {
    const body = (await res.json()) as { request?: RequestView };
    if (body.request) {
      return { ok: false, alreadyRequested: true, request: body.request };
    }
    throw new Error("Already requested");
  }

  if (!res.ok) {
    throw new Error(`Failed to create request (${res.status})`);
  }

  return { ok: true, request: (await res.json()) as RequestView };
}

/**
 * GET /api/requests. The caller's own requests, in whatever order Seerr hands
 * them back. Sorting and filtering happen client-side in lib/requestControls.ts.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchMyRequests(): Promise<RequestView[]> {
  const res = await fetch("/api/requests");
  if (!res.ok) {
    throw new Error(`Failed to load requests (${res.status})`);
  }
  const body = (await res.json()) as { results: RequestView[] };
  return body.results;
}

/**
 * GET /api/requests/all. Everybody's requests, for the admin queue. Same shape
 * as fetchMyRequests.
 *
 * @throws Error on any non-2xx, including 403 for a non-admin.
 */
export async function fetchAllRequests(): Promise<RequestView[]> {
  const res = await fetch("/api/requests/all");
  if (!res.ok) {
    throw new Error(`Failed to load all requests (${res.status})`);
  }
  const body = (await res.json()) as { results: RequestView[] };
  return body.results;
}

/**
 * GET /api/requests/profiles. Quality profiles for the request dialog.
 *
 * Admin-only server-side, so call it conditionally. A non-admin gets a 403 and
 * a thrown error rather than an empty list.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchRequestProfiles(
  mediaType: MediaType,
): Promise<RequestProfiles> {
  const params = new URLSearchParams({ mediaType });
  const res = await fetch(`/api/requests/profiles?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to load quality profiles (${res.status})`);
  }
  return (await res.json()) as RequestProfiles;
}

/**
 * POST /api/requests/:id/approve. Releases a pending request to Radarr or
 * Sonarr, so this is the click that actually starts a download. Returns the
 * updated row for an in-place swap in the table.
 *
 * @throws Error on any non-2xx. An id Seerr doesn't recognise reads as 502
 * rather than 404.
 */
export async function approveRequest(id: number): Promise<RequestView> {
  const res = await fetch(`/api/requests/${id}/approve`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to approve request (${res.status})`);
  }
  return (await res.json()) as RequestView;
}

/**
 * POST /api/requests/:id/decline. Mirror of approveRequest.
 *
 * @throws Error on any non-2xx.
 */
export async function declineRequest(id: number): Promise<RequestView> {
  const res = await fetch(`/api/requests/${id}/decline`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to decline request (${res.status})`);
  }
  return (await res.json()) as RequestView;
}

/**
 * Renders Seerr's ISO timestamp as a short date in the viewer's locale. An
 * unparseable string comes back untouched rather than as "Invalid Date".
 */
export function formatRequestDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Badge class for the approval status. "completed" and "approved" deliberately
 * share the green class, since from a requester's point of view they're the
 * same good news.
 */
export function requestStatusBadgeClass(
  status: RequestApprovalStatus,
): string {
  switch (status) {
    case "pending":
      return "request-status request-status-pending";
    case "approved":
      return "request-status request-status-approved";
    case "completed":
      return "request-status request-status-approved";
    case "declined":
      return "request-status request-status-declined";
    case "failed":
      return "request-status request-status-failed";
  }
}

/**
 * Human label for an availability status. The switch covers every member with
 * no default arm, which is what keeps it in step with the union.
 */
export function mediaStatusLabel(status: MediaAvailabilityStatus): string {
  switch (status) {
    case "unknown":
      return "Unknown";
    case "pending":
      return "Pending";
    case "processing":
      return "Processing";
    case "partially_available":
      return "Partially available";
    case "available":
      return "Available";
    case "blocklisted":
      return "Blocklisted";
    case "deleted":
      return "Deleted";
  }
}
