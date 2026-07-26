export type AccessRequestInput = {
  email: string;
  name: string;
  note: string;
  hasPlexAccount: boolean;
  plexUsername?: string;
  website: string;
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
