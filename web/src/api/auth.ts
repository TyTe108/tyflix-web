export type AuthUser = {
  seerrUserId: number;
  plexId: number;
  plexUsername: string;
  displayName: string;
  avatar: string | null;
  permissions: number;
  email?: string | null;
};

export type MeResponse = {
  user: AuthUser;
  isAdmin: boolean;
};

export type PlexStartResponse = {
  pinId: number;
  code: string;
  authUrl: string;
};

export type PlexCheckPending = { status: "pending" };

export type PlexCheckOk = {
  status: "ok";
  user: AuthUser;
  isAdmin: boolean;
};

export type PlexCheckForbidden = {
  status: "forbidden";
  message: string;
};

export async function fetchMe(): Promise<MeResponse | null> {
  const res = await fetch("/api/auth/me");
  if (res.status === 401) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to load session (${res.status})`);
  }
  return (await res.json()) as MeResponse;
}

export async function logoutRequest(): Promise<void> {
  const res = await fetch("/api/auth/logout", { method: "POST" });
  if (!res.ok) {
    throw new Error(`Logout failed (${res.status})`);
  }
}

export async function startPlexLogin(): Promise<PlexStartResponse> {
  const res = await fetch("/api/auth/plex/start", { method: "POST" });
  if (!res.ok) {
    throw new Error(`Could not start Plex login (${res.status})`);
  }
  return (await res.json()) as PlexStartResponse;
}

export type PlexCheckResult =
  | { kind: "pending" }
  | { kind: "ok"; data: PlexCheckOk }
  | { kind: "forbidden"; message: string }
  | { kind: "error"; message: string };

export async function checkPlexLogin(pinId: number): Promise<PlexCheckResult> {
  let res: Response;
  try {
    res = await fetch(`/api/auth/plex/check?pinId=${encodeURIComponent(String(pinId))}`);
  } catch {
    return { kind: "error", message: "Network error while checking Plex login." };
  }

  if (res.status === 403) {
    const body = (await res.json()) as PlexCheckForbidden;
    return {
      kind: "forbidden",
      message:
        body.message ||
        "Your Plex account isn't a Tyflix member.",
    };
  }

  if (!res.ok) {
    return {
      kind: "error",
      message: `Plex check failed (${res.status}).`,
    };
  }

  const body: unknown = await res.json();
  if (
    typeof body === "object" &&
    body !== null &&
    (body as { status?: unknown }).status === "pending"
  ) {
    return { kind: "pending" };
  }

  if (
    typeof body === "object" &&
    body !== null &&
    (body as { status?: unknown }).status === "ok"
  ) {
    return { kind: "ok", data: body as PlexCheckOk };
  }

  return { kind: "error", message: "Unexpected response from Plex check." };
}
