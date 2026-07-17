import type { MediaType } from "./discover";

export type RequestApprovalStatus =
  | "pending"
  | "approved"
  | "declined"
  | "failed"
  | "completed";

export type MediaAvailabilityStatus =
  | "unknown"
  | "pending"
  | "processing"
  | "partially_available"
  | "available"
  | "blocklisted"
  | "deleted";

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

export type CreateRequestInput = {
  tmdbId: number;
  mediaType: MediaType;
  seasons?: number[];
  profileId?: number;
};

export type RequestProfiles = {
  serverId: number;
  defaultProfileId: number;
  profiles: Array<{ id: number; name: string }>;
};

export type CreateRequestResult =
  | { ok: true; request: RequestView }
  | { ok: false; alreadyRequested: true; request: RequestView };

export async function createRequest(
  input: CreateRequestInput,
): Promise<CreateRequestResult> {
  const res = await fetch("/api/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

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

export async function fetchMyRequests(): Promise<RequestView[]> {
  const res = await fetch("/api/requests");
  if (!res.ok) {
    throw new Error(`Failed to load requests (${res.status})`);
  }
  const body = (await res.json()) as { results: RequestView[] };
  return body.results;
}

export async function fetchAllRequests(): Promise<RequestView[]> {
  const res = await fetch("/api/requests/all");
  if (!res.ok) {
    throw new Error(`Failed to load all requests (${res.status})`);
  }
  const body = (await res.json()) as { results: RequestView[] };
  return body.results;
}

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

export async function approveRequest(id: number): Promise<RequestView> {
  const res = await fetch(`/api/requests/${id}/approve`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to approve request (${res.status})`);
  }
  return (await res.json()) as RequestView;
}

export async function declineRequest(id: number): Promise<RequestView> {
  const res = await fetch(`/api/requests/${id}/decline`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to decline request (${res.status})`);
  }
  return (await res.json()) as RequestView;
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
    case "completed":
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
    case "blocklisted":
      return "Blocklisted";
    case "deleted":
      return "Deleted";
  }
}
