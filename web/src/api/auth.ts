// Client for the server's auth router (server/src/routes/auth.ts), mounted at
// /api/auth. One of the app's three public routers (the others are /api/config
// and /api/access-requests), and the one that creates a session in the first
// place.
//
// Login is Plex's PIN handshake, the same one their own apps use. Three steps:
// startPlexLogin asks plex.tv for a PIN, LoginPage opens Plex's auth page in a
// popup, and checkPlexLogin polls until Plex attaches a token to that PIN. The
// server then confirms with Seerr that the account is actually a member of this
// server before it issues anything.
//
// No Plex token ever reaches this code. The server encrypts it into a signed
// httpOnly cookie, so the browser holds an opaque session and nothing else.
// That's why there's no token in AuthUser and no Authorization header anywhere
// in api/.
//
// This file breaks the usual throw-on-non-2xx rule twice, and both times on
// purpose. fetchMe returns null for a 401, because "logged out" is an answer
// rather than a failure. checkPlexLogin never throws at all, because it runs on
// a poll loop where an exception per tick would be useless. See each one below.

// The identity the app renders: sidebar name, avatar, permission bits. `email`
// only ever comes back from checkPlexLogin, since the session cookie doesn't
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
export type MeResponse = {
  user: AuthUser;
  isAdmin: boolean;
};

// Step one of the PIN flow. `code` is the short code Plex shows the user, and
// `authUrl` is what the popup navigates to.
export type PlexStartResponse = {
  pinId: number;
  code: string;
  authUrl: string;
};

// The three server-side shapes of a poll tick. "pending" means the user hasn't
// finished on Plex's side yet and nothing has been touched; the server
// deliberately stops before doing any Seerr work in that case. "forbidden"
// means the Plex account isn't a member of this server, and no cookie is set.
//
// NOTE: PlexCheckPending isn't referenced anywhere. checkPlexLogin narrows the
// pending case with an inline property check instead, so this type documents
// the wire shape and nothing more.
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
  return (await res.json()) as MeResponse;
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

/**
 * POST /api/auth/plex/start. Opens the PIN handshake.
 *
 * The caller sends the browser to `authUrl` in a popup and then polls
 * checkPlexLogin with the returned `pinId`.
 *
 * @throws Error when plex.tv won't hand out a PIN.
 */
export async function startPlexLogin(): Promise<PlexStartResponse> {
  const res = await fetch("/api/auth/plex/start", { method: "POST" });
  if (!res.ok) {
    throw new Error(`Could not start Plex login (${res.status})`);
  }
  return (await res.json()) as PlexStartResponse;
}

// What one poll tick can conclude. Note "error" is separate from "forbidden":
// a Seerr outage must never look like a rejected login, and the server splits
// those two the same way (403 for not-a-member, 502 for anything else).
export type PlexCheckResult =
  | { kind: "pending" }
  | { kind: "ok"; data: PlexCheckOk }
  | { kind: "forbidden"; message: string }
  | { kind: "error"; message: string };

/**
 * GET /api/auth/plex/check. One tick of the login poll.
 *
 * Never throws. LoginPage calls this on a timer while the Plex popup is open,
 * and an exception per tick would just be noise, so every outcome including a
 * network failure comes back as a result variant.
 *
 * On "ok" the session cookie has already been set by the response this call
 * just read, so the caller's next move is to refresh AuthContext, not to store
 * anything from `data`.
 *
 * The unrecognised-body case at the bottom is defensive rather than expected;
 * the server only ever sends "pending" or "ok" with a 2xx.
 */
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
