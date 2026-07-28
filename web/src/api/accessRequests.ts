export type AccessRequestInput = {
  email: string;
  name: string;
  note: string;
  hasPlexAccount: boolean;
  plexUsername?: string;
  website: string;
};

export type AccessRequestStatus =
  | "pending"
  | "invited"
  | "accepted"
  | "denied";

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
  plexInviteMissing?: boolean;
};

export type AccessRequestsListResponse = {
  requests: AccessRequestView[];
  reconciledAt: number | null;
};

export type ShareableSection = {
  id: number;
  key: number;
  title: string;
  type: string;
};

export type SubmitAccessRequestResult =
  | { ok: true }
  | { ok: false; kind: "validation"; message: string }
  | { ok: false; kind: "rateLimited" }
  | { ok: false; kind: "error"; message: string };

/**
 * POST /api/access-requests. Does not throw on 400/429 — those are returned as
 * discriminated results so the wizard can render them inline.
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

export async function fetchAccessRequests(): Promise<AccessRequestsListResponse> {
  const res = await fetch("/api/admin/access-requests");
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load access requests"));
  }
  return (await res.json()) as AccessRequestsListResponse;
}

export async function fetchAccessRequestSections(): Promise<ShareableSection[]> {
  const res = await fetch("/api/admin/access-requests/sections");
  if (!res.ok) {
    throw new Error(
      await errorMessage(res, "Failed to load shareable sections"),
    );
  }
  return (await res.json()) as ShareableSection[];
}

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

export async function denyAccessRequest(id: string): Promise<AccessRequest> {
  const res = await fetch(
    `/api/admin/access-requests/${encodeURIComponent(id)}/deny`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to deny access request"));
  }
  return (await res.json()) as AccessRequest;
}

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
