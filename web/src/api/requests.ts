import type { MediaType } from "./discover";

export type RequestApprovalStatus =
  | "pending"
  | "approved"
  | "declined"
  | "failed";

export type MediaAvailabilityStatus =
  | "unknown"
  | "pending"
  | "processing"
  | "partially_available"
  | "available";

export type RequestRow = {
  id: number;
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  seasons: number[] | null;
  requestedBySeerrId: number;
  requestedByName: string;
  requestStatus: RequestApprovalStatus;
  mediaStatus: MediaAvailabilityStatus;
  radarrId: number | null;
  sonarrId: number | null;
  createdAt: string;
  updatedAt: string;
  decidedBy: number | null;
  decidedAt: string | null;
};

export type CreateRequestInput = {
  tmdbId: number;
  mediaType: MediaType;
  seasons?: number[];
};

export type CreateRequestResult =
  | { ok: true; request: RequestRow }
  | { ok: false; alreadyRequested: true; request: RequestRow };

export async function createRequest(
  input: CreateRequestInput,
): Promise<CreateRequestResult> {
  const res = await fetch("/api/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (res.status === 409) {
    const body = (await res.json()) as { request?: RequestRow };
    if (body.request) {
      return { ok: false, alreadyRequested: true, request: body.request };
    }
    throw new Error("Already requested");
  }

  if (!res.ok) {
    throw new Error(`Failed to create request (${res.status})`);
  }

  return { ok: true, request: (await res.json()) as RequestRow };
}

export async function fetchMyRequests(): Promise<RequestRow[]> {
  const res = await fetch("/api/requests");
  if (!res.ok) {
    throw new Error(`Failed to load requests (${res.status})`);
  }
  const body = (await res.json()) as { results: RequestRow[] };
  return body.results;
}

export async function fetchAllRequests(): Promise<RequestRow[]> {
  const res = await fetch("/api/requests/all");
  if (!res.ok) {
    throw new Error(`Failed to load all requests (${res.status})`);
  }
  const body = (await res.json()) as { results: RequestRow[] };
  return body.results;
}

export async function approveRequest(id: number): Promise<RequestRow> {
  const res = await fetch(`/api/requests/${id}/approve`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to approve request (${res.status})`);
  }
  return (await res.json()) as RequestRow;
}

export async function declineRequest(id: number): Promise<RequestRow> {
  const res = await fetch(`/api/requests/${id}/decline`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to decline request (${res.status})`);
  }
  return (await res.json()) as RequestRow;
}

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

export function requestStatusBadgeClass(
  status: RequestApprovalStatus,
): string {
  switch (status) {
    case "pending":
      return "request-status request-status-pending";
    case "approved":
      return "request-status request-status-approved";
    case "declined":
      return "request-status request-status-declined";
    case "failed":
      return "request-status request-status-failed";
  }
}

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
  }
}
