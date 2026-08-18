// Client for the server's auth router (server/src/routes/auth.ts), mounted at
// /api/auth. One of the app's three public routers (the others are /api/config
// and /api/access-requests), and the one that creates a session in the first
// place.
//
// Login is Plex's PIN handshake. LoginPage creates and polls the PIN in the
// browser (see lib/plexOauth.ts), then completePlexLogin posts the resulting
// authToken to the server once. The server confirms with Seerr that the
// account is a member of this server before it issues a session.
//
// The user's own Plex token transits their own browser in memory during login
// only, is posted once to /api/auth/plex/complete, and the browser holds
// nothing but the httpOnly session cookie afterward. That's why there's no
// token in AuthUser and no Authorization header anywhere in api/.
//
// This file breaks the usual throw-on-non-2xx rule twice, and both times on
// purpose. fetchMe returns null for a 401, because "logged out" is an answer
// rather than a failure. completePlexLogin never throws at all, because the
// login page wants every outcome as a result variant. See each one below.

// The identity the app renders: sidebar name, avatar, permission bits. `email`
// only ever comes back from completePlexLogin, since the session cookie doesn't
// carry it and /me is built purely from the cookie.
export type AuthUser = {
  seerrUserId: number;
  plexId: number;
  plexUsername: string;
  displayName: string;
  avatar: string | null;
  permissions: number; // Seerr's permission bitmask
  email?: string | null;
};

// `isAdmin` is decided server-side from the permission bits (Seerr's admin bit),
// so the client never has to know how that's computed.
export type UserPreferences = {
  fullscreenOnPlay: boolean;
};

/** Default when /me hasn't answered yet, after logout, or when the field is bad. */
export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  fullscreenOnPlay: true,
};

export type MeResponse = {
  user: AuthUser;
  isAdmin: boolean;
  preferences: UserPreferences;
};

export type PlexCheckOk = {
  status: "ok";
  user: AuthUser;
  isAdmin: boolean;
};

export type PlexCheckForbidden = {
  status: "forbidden";
  message: string;
};

/**
 * GET /api/auth/me. Who's signed in, read straight out of the cookie.
 *
 * Makes no upstream calls at all server-side, which is what makes it cheap
 * enough for AuthProvider to run on every page load.
 *
 * @returns null on 401, meaning no session, a tampered cookie, or an expired
 * one. Callers can't tell those apart and don't need to.
 * @throws Error on any other non-2xx.
 */
export async function fetchMe(): Promise<MeResponse | null> {
  const res = await fetch("/api/auth/me");
  if (res.status === 401) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to load session (${res.status})`);
  }
  const body = (await res.json()) as MeResponse;
  // Guard the unchecked cast: a missing or malformed preferences field must
  // not leave undefined for callers to blow up on when they read
  // .fullscreenOnPlay. Not version skew — server and SPA ship together.
  return {
    ...body,
    preferences: normalizePreferences(body.preferences),
  };
}

/**
 * Turns whatever landed on `preferences` into a usable UserPreferences.
 * Absent, non-object, or non-boolean fullscreenOnPlay → the default.
 */
function normalizePreferences(raw: unknown): UserPreferences {
  if (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as { fullscreenOnPlay?: unknown }).fullscreenOnPlay ===
      "boolean"
  ) {
    return {
      fullscreenOnPlay: (raw as { fullscreenOnPlay: boolean })
        .fullscreenOnPlay,
    };
  }
  return { ...DEFAULT_USER_PREFERENCES };
}

/**
 * POST /api/auth/logout. Clears the session cookie.
 *
 * Always 200 server-side, even without a session. Nothing is revoked on Plex's
 * side; the encrypted token just stops being reachable.
 *
 * @throws Error on a non-2xx, which in practice means the network died.
 * AuthContext clears local state either way.
 */
export async function logoutRequest(): Promise<void> {
  const res = await fetch("/api/auth/logout", { method: "POST" });
  if (!res.ok) {
    throw new Error(`Logout failed (${res.status})`);
  }
}

// What finishing a browser-side PIN handshake can conclude. Note "error" is
// separate from "forbidden": a Seerr outage must never look like a rejected
// login, and the server splits those two the same way (403 for not-a-member,
// 502 for anything else). "pending" remains in the union for type continuity
// but completePlexLogin never returns it (polling is client-side now).
export type PlexCheckResult =
  | { kind: "pending" }
  | { kind: "ok"; data: PlexCheckOk }
  | { kind: "forbidden"; message: string }
  | { kind: "error"; message: string };

/**
 * POST /api/auth/plex/complete. Hands a browser-obtained Plex authToken to the
 * server to mint the session cookie.
 *
 * Never throws. LoginPage calls this once a PIN poll yields a token, and every
 * outcome including a network failure comes back as a result variant.
 *
 * On "ok" the session cookie has already been set by the response this call
 * just read, so the caller's next move is to refresh AuthContext, not to store
 * anything from `data`.
 */
export async function completePlexLogin(
  authToken: string,
): Promise<PlexCheckResult> {
  let res: Response;
  try {
    res = await fetch("/api/auth/plex/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authToken }),
    });
  } catch {
    return {
      kind: "error",
      message: "Network error while completing Plex login.",
    };
  }

  if (res.status === 403) {
    const body = (await res.json()) as PlexCheckForbidden;
    return {
      kind: "forbidden",
      message: body.message || "Your Plex account isn't a Tyflix member.",
    };
  }

  if (!res.ok) {
    return {
      kind: "error",
      message: `Plex login failed (${res.status}).`,
    };
  }

  const body: unknown = await res.json();
  if (
    typeof body === "object" &&
    body !== null &&
    (body as { status?: unknown }).status === "ok"
  ) {
    return { kind: "ok", data: body as PlexCheckOk };
  }

  return { kind: "error", message: "Unexpected response from Plex login." };
}
