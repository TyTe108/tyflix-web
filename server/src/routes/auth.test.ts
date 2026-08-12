import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import express from "express";
import { requireAuth } from "../middleware/auth";
import { clearPermissionCacheForTests } from "../middleware/revalidatePermissions";
import {
  PlexUpstreamError,
  type PlexClient,
  type PlexUser,
} from "../plex/client";
import {
  SeerrUpstreamError,
  type SeerrClient,
  type SeerrUser,
} from "../seerr/client";
import {
  createSessionRevocationStore,
  type SessionRevocationStore,
} from "../sessionRevocation";
import { issueSession, SESSION_COOKIE_NAME } from "../session";
import { createAuthRouter } from "./auth";

beforeEach(() => {
  clearPermissionCacheForTests();
});

const SECRET = "sixteen-chars!!!";

async function tempRevocationStore(
  now?: () => number,
): Promise<SessionRevocationStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "tyflix-auth-route-rev-"));
  return createSessionRevocationStore(
    path.join(dir, "session-revocation.json"),
    now !== undefined ? { now } : {},
  );
}

function plexUser(overrides: Partial<PlexUser> = {}): PlexUser {
  return {
    id: 100,
    username: "alice",
    email: "a@example.com",
    thumb: "https://plex/avatar.png",
    ...overrides,
  };
}

function seerrUser(overrides: Partial<SeerrUser> = {}): SeerrUser {
  return {
    id: 9,
    plexId: 100,
    plexUsername: "alice",
    displayName: "Alice",
    email: "a@example.com",
    permissions: 0,
    ...overrides,
  };
}

type Calls = {
  signInTokens: string[];
  getUserPlexIds: number[];
  getUserTokens: string[];
};

function buildApp(
  overrides: {
    plex?: Partial<PlexClient>;
    seerr?: Partial<SeerrClient> & {
      getUserById?: (id: number) => Promise<SeerrUser | null>;
    };
    sessionRevocation?: SessionRevocationStore;
  } = {},
): { app: express.Express; calls: Calls; sessionRevocation: SessionRevocationStore } {
  const calls: Calls = {
    signInTokens: [],
    getUserPlexIds: [],
    getUserTokens: [],
  };

  const plex = {
    async getUser(authToken: string) {
      calls.getUserTokens.push(authToken);
      return plexUser();
    },
    ...overrides.plex,
  } as unknown as PlexClient;

  const seerr = {
    async signInWithPlex(authToken: string) {
      calls.signInTokens.push(authToken);
      return null;
    },
    async getUserByPlexId(plexId: number) {
      calls.getUserPlexIds.push(plexId);
      return seerrUser();
    },
    async getUserById(id: number) {
      return seerrUser({ id });
    },
    ...overrides.seerr,
  } as unknown as SeerrClient;

  // Lazy sync placeholder — tests that need real revocation pass one in.
  // Existing /plex/complete and /me cases use a never-revokes stub.
  const sessionRevocation =
    overrides.sessionRevocation ??
    ({
      isRevoked: () => false,
      async revokeSessionsBefore() {
        /* no-op stub for tests that don't exercise logout */
      },
    } satisfies SessionRevocationStore);

  const app = express();
  app.use(express.json());
  app.use(
    "/api/auth",
    createAuthRouter({
      plex,
      seerr,
      sessionSecret: SECRET,
      secureCookies: false,
      sessionRevocation,
    }),
  );
  // Protected probe used by logout tests to assert the cookie is dead.
  app.use(
    "/api/probe",
    requireAuth(SECRET, seerr, sessionRevocation),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  return { app, calls, sessionRevocation };
}

function sessionCookieValue(response: Response): string | null {
  for (const cookie of response.headers.getSetCookie()) {
    if (cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      return cookie;
    }
  }
  return null;
}

function meCookie(permissions: number, seerrUserId = 9): string {
  const cookies: Array<{ name: string; value: string }> = [];
  const res = {
    cookie(name: string, value: string) {
      cookies.push({ name, value });
    },
  };
  issueSession(
    res as unknown as import("express").Response,
    {
      seerrUserId,
      plexId: 100,
      plexUsername: "alice",
      displayName: "Alice",
      avatar: "https://plex/avatar.png",
      permissions,
    },
    { secret: SECRET, secure: false },
  );
  return `${SESSION_COOKIE_NAME}=${cookies[0].value}`;
}

/**
 * Cookie with a controlled iat. Used by logout tests so the session is older
 * than the revoke timestamp (issueSession's real-clock iat can land in the
 * same second as logout, and iat === validAfter is deliberately valid).
 */
function meCookieIssuedAt(
  iat: number,
  permissions: number,
  seerrUserId = 9,
): string {
  const payload = {
    seerrUserId,
    plexId: 100,
    plexUsername: "alice",
    displayName: "Alice",
    avatar: "https://plex/avatar.png",
    permissions,
    iat,
    exp: iat + 30 * 24 * 60 * 60,
  };
  const json = JSON.stringify(payload);
  const payloadPart = Buffer.from(json, "utf8").toString("base64url");
  const sigPart = createHmac("sha256", SECRET)
    .update(json)
    .digest("base64url");
  return `${SESSION_COOKIE_NAME}=${payloadPart}.${sigPart}`;
}

async function fetchMe(
  app: express.Express,
  cookie: string | null,
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    return await fetch(`http://127.0.0.1:${address.port}/api/auth/me`, {
      headers: cookie === null ? {} : { cookie },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("GET /api/auth/me", () => {
  it("returns permissions/isAdmin from a fresh Seerr check, not the cookie", async () => {
    // Cookie says admin (2); Seerr alone returns 0. Trusting the cookie would
    // yield isAdmin true — the failure mode this case is named after.
    const getUserIds: number[] = [];
    const { app } = buildApp({
      seerr: {
        async getUserById(id: number) {
          getUserIds.push(id);
          return seerrUser({ id, permissions: 0 });
        },
      },
    });

    const response = await fetchMe(app, meCookie(2, 9));
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      user: { permissions: number };
      isAdmin: boolean;
    };
    assert.equal(body.user.permissions, 0);
    assert.equal(body.isAdmin, false);
    assert.deepEqual(getUserIds, [9]);
  });

  it("returns 503 when the Seerr lookup throws", async () => {
    // Stub fails in exactly one mode: throw. 401 would be the not-found branch.
    const { app } = buildApp({
      seerr: {
        async getUserById() {
          throw new Error("connection refused");
        },
      },
    });

    const response = await fetchMe(app, meCookie(2));
    assert.equal(response.status, 503);
  });

  it("returns 401 when Seerr reports the account no longer exists", async () => {
    // Stub fails in exactly one mode: null (404 signal). 503 would mean we
    // collapsed not-found into unreachable.
    const { app } = buildApp({
      seerr: {
        async getUserById() {
          return null;
        },
      },
    });

    const response = await fetchMe(app, meCookie(2));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "not authenticated" });
  });

  it("happy path: mirrors Seerr permissions and isAdmin", async () => {
    const { app } = buildApp({
      seerr: {
        async getUserById(id: number) {
          return seerrUser({ id, permissions: 2 });
        },
      },
    });

    const response = await fetchMe(app, meCookie(0, 9));
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      user: { permissions: number; seerrUserId: number };
      isAdmin: boolean;
    };
    assert.equal(body.user.permissions, 2);
    assert.equal(body.user.seerrUserId, 9);
    assert.equal(body.isAdmin, true);
  });
});

async function fetchLocal(
  app: express.Express,
  pathName: string,
  init: RequestInit = {},
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    return await fetch(`http://127.0.0.1:${address.port}${pathName}`, init);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function cookieHeaderFromSetCookie(setCookie: string): string {
  // Keep only name=value; drop Path/HttpOnly/etc. attributes.
  return setCookie.split(";")[0]!;
}

describe("POST /api/auth/plex/complete", () => {
  async function completePlex(
    app: express.Express,
    body: unknown,
    init: { omitContentType?: boolean } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (!init.omitContentType) {
      headers["content-type"] = "application/json";
    }
    return fetchLocal(app, "/api/auth/plex/complete", {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("mints a session and returns the ok body with identity fields", async () => {
    const { app, calls } = buildApp({
      seerr: {
        async signInWithPlex(authToken: string) {
          calls.signInTokens.push(authToken);
          return seerrUser({ id: 42, plexId: 100, permissions: 0 });
        },
      },
    });

    const response = await completePlex(app, { authToken: "client-token-xyz" });

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: string;
      user: {
        seerrUserId: number;
        plexId: number;
        plexUsername: string;
        displayName: string;
        email: string | null;
        avatar: string | null;
        permissions: number;
      };
      isAdmin: boolean;
    };
    assert.equal(body.status, "ok");
    assert.deepEqual(body.user, {
      seerrUserId: 42,
      plexId: 100,
      plexUsername: "alice",
      displayName: "Alice",
      email: "a@example.com",
      avatar: "https://plex/avatar.png",
      permissions: 0,
    });
    assert.equal(body.isAdmin, false);
    assert.deepEqual(calls.getUserTokens, ["client-token-xyz"]);
    assert.deepEqual(calls.signInTokens, ["client-token-xyz"]);
    assert.notEqual(sessionCookieValue(response), null);
  });

  it("onboards a brand-new Plex member (signInWithPlex then getUserByPlexId)", async () => {
    const { app, calls } = buildApp({
      seerr: {
        async signInWithPlex(authToken: string) {
          calls.signInTokens.push(authToken);
          return null; // real Seerr body omits plexId -> fall back
        },
        async getUserByPlexId(plexId: number) {
          calls.getUserPlexIds.push(plexId);
          return seerrUser({ id: 42, plexId, permissions: 0 });
        },
      },
    });

    const response = await completePlex(app, { authToken: "client-token-xyz" });

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: string;
      user: { seerrUserId: number; plexId: number; avatar: string | null };
      isAdmin: boolean;
    };
    assert.equal(body.status, "ok");
    assert.equal(body.user.seerrUserId, 42);
    assert.equal(body.user.plexId, 100);
    assert.equal(body.user.avatar, "https://plex/avatar.png");
    assert.equal(body.isAdmin, false);

    // Sign-in happened with the Plex authToken, then we resolved the record.
    assert.deepEqual(calls.signInTokens, ["client-token-xyz"]);
    assert.deepEqual(calls.getUserPlexIds, [100]);

    // A Tyflix session cookie is issued.
    assert.notEqual(sessionCookieValue(response), null);
  });

  it("still 403s when sign-in succeeds but the user cannot be resolved", async () => {
    const { app } = buildApp({
      seerr: {
        async signInWithPlex() {
          return null;
        },
        async getUserByPlexId() {
          return null;
        },
      },
    });

    const response = await completePlex(app, { authToken: "client-token-xyz" });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      status: "forbidden",
      message: "Your Plex account isn't a Tyflix member.",
    });
    assert.equal(sessionCookieValue(response), null);
  });

  it("rejects malformed bodies with 400 and never calls upstream", async () => {
    const cases: Array<{
      label: string;
      body: unknown;
      omitContentType?: boolean;
    }> = [
      // No Content-Type -> express.json leaves req.body undefined.
      { label: "missing body", body: undefined, omitContentType: true },
      // Arrays parse under express.json strict mode; our handler still rejects.
      { label: "non-object body", body: [] },
      { label: "missing authToken", body: {} },
      { label: "non-string authToken", body: { authToken: 123 } },
      { label: "empty authToken", body: { authToken: "" } },
      { label: "whitespace authToken", body: { authToken: "   " } },
      {
        label: "authToken longer than 1024",
        body: { authToken: "x".repeat(1025) },
      },
    ];

    for (const { label, body, omitContentType } of cases) {
      const { app, calls } = buildApp();
      const response = await completePlex(app, body, { omitContentType });
      assert.equal(response.status, 400, label);
      const json = (await response.json()) as { error?: unknown };
      assert.equal(typeof json.error, "string", label);
      assert.deepEqual(calls.getUserTokens, [], label);
      assert.deepEqual(calls.signInTokens, [], label);
      assert.equal(sessionCookieValue(response), null, label);
    }
  });

  it("returns 401 when plex.getUser rejects the token and sets no cookie", async () => {
    const { app } = buildApp({
      plex: {
        async getUser() {
          throw new PlexUpstreamError("Plex getUser failed (401)", 401);
        },
      },
    });

    const response = await completePlex(app, { authToken: "bad-token" });

    assert.equal(response.status, 401);
    const body = (await response.json()) as { error?: unknown };
    assert.equal(typeof body.error, "string");
    assert.equal(sessionCookieValue(response), null);
  });

  it("returns 403 when Seerr denies access and sets no cookie", async () => {
    for (const status of [401, 403, 422] as const) {
      const { app } = buildApp({
        seerr: {
          async signInWithPlex() {
            throw new SeerrUpstreamError(
              `Seerr /api/v1/auth/plex failed (${status})`,
              status,
            );
          },
        },
      });

      const response = await completePlex(app, { authToken: "valid-looking" });

      assert.equal(response.status, 403, `Seerr ${status}`);
      assert.deepEqual(await response.json(), {
        status: "forbidden",
        message: "Your Plex account isn't a Tyflix member.",
      });
      assert.equal(sessionCookieValue(response), null, `Seerr ${status}`);
    }
  });

  it("returns 502 for other upstream failures and sets no cookie", async () => {
    const cases: Array<{
      label: string;
      plex?: Partial<PlexClient>;
      seerr?: Partial<SeerrClient>;
    }> = [
      {
        label: "plex.getUser non-401",
        plex: {
          async getUser() {
            throw new PlexUpstreamError("Plex getUser failed (500)", 500);
          },
        },
      },
      {
        label: "Seerr 500",
        seerr: {
          async signInWithPlex() {
            throw new SeerrUpstreamError(
              "Seerr /api/v1/auth/plex failed (500)",
              500,
            );
          },
        },
      },
      {
        label: "network throw",
        plex: {
          async getUser() {
            throw new Error("connection refused");
          },
        },
      },
    ];

    for (const { label, plex, seerr } of cases) {
      const { app } = buildApp({ plex, seerr });
      const response = await completePlex(app, { authToken: "valid-looking" });
      assert.equal(response.status, 502, label);
      const body = (await response.json()) as { error?: unknown };
      assert.equal(typeof body.error, "string", label);
      assert.equal(sessionCookieValue(response), null, label);
    }
  });
});

describe("POST /api/auth/logout", () => {
  it("returns 200 {ok:true} even when there is no session", async () => {
    const revocation = await tempRevocationStore();
    const { app } = buildApp({ sessionRevocation: revocation });

    const response = await fetchLocal(app, "/api/auth/logout", {
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  it("invalidates the caller's cookie against a protected route", async () => {
    const revocation = await tempRevocationStore();
    const { app } = buildApp({
      sessionRevocation: revocation,
      seerr: {
        async getUserById(id: number) {
          return seerrUser({ id, permissions: 0 });
        },
      },
    });

    const cookie = meCookieIssuedAt(Math.floor(Date.now() / 1000) - 60, 0, 9);

    const before = await fetchLocal(app, "/api/probe", {
      headers: { cookie },
    });
    assert.equal(before.status, 200);

    const logout = await fetchLocal(app, "/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { ok: true });

    // Same cookie value still sent — must be 401, not merely a cleared Set-Cookie.
    const after = await fetchLocal(app, "/api/probe", {
      headers: { cookie },
    });
    assert.equal(after.status, 401);
    assert.deepEqual(await after.json(), { error: "not authenticated" });
  });

  it("rejects a second separately-held copy of the same pre-logout cookie", async () => {
    // Per-user revocation: two "sessions" (copies) for the same user; one
    // logout must kill both. A per-cookie-instance fix would leave copy B alive.
    const revocation = await tempRevocationStore();
    const { app } = buildApp({
      sessionRevocation: revocation,
      seerr: {
        async getUserById(id: number) {
          return seerrUser({ id, permissions: 0 });
        },
      },
    });

    const cookieA = meCookieIssuedAt(Math.floor(Date.now() / 1000) - 60, 0, 9);
    const cookieB = cookieA; // separately held copy of the same signed cookie

    const logout = await fetchLocal(app, "/api/auth/logout", {
      method: "POST",
      headers: { cookie: cookieA },
    });
    assert.equal(logout.status, 200);

    const probeA = await fetchLocal(app, "/api/probe", {
      headers: { cookie: cookieA },
    });
    const probeB = await fetchLocal(app, "/api/probe", {
      headers: { cookie: cookieB },
    });
    assert.equal(probeA.status, 401);
    assert.equal(probeB.status, 401);
    assert.deepEqual(await probeA.json(), { error: "not authenticated" });
    assert.deepEqual(await probeB.json(), { error: "not authenticated" });
  });

  it("allows a fresh login immediately after logout", async () => {
    const revocation = await tempRevocationStore();
    const { app } = buildApp({
      sessionRevocation: revocation,
      seerr: {
        async signInWithPlex() {
          return seerrUser({ id: 9, plexId: 100, permissions: 0 });
        },
        async getUserById(id: number) {
          return seerrUser({ id, permissions: 0 });
        },
      },
    });

    const oldCookie = meCookieIssuedAt(Math.floor(Date.now() / 1000) - 60, 0, 9);

    const logout = await fetchLocal(app, "/api/auth/logout", {
      method: "POST",
      headers: { cookie: oldCookie },
    });
    assert.equal(logout.status, 200);

    const dead = await fetchLocal(app, "/api/probe", {
      headers: { cookie: oldCookie },
    });
    assert.equal(dead.status, 401);

    // New /plex/complete session for the same user must work (iat >= validAfter).
    const login = await fetchLocal(app, "/api/auth/plex/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authToken: "plex-token-abc" }),
    });
    assert.equal(login.status, 200);
    const setCookie = sessionCookieValue(login);
    assert.notEqual(setCookie, null);
    const newCookie = cookieHeaderFromSetCookie(setCookie!);

    const alive = await fetchLocal(app, "/api/probe", {
      headers: { cookie: newCookie },
    });
    assert.equal(alive.status, 200);
  });

  it("does not return 200 {ok:true} when revokeSessionsBefore fails", async () => {
    // Fail-loud: a write failure must not clear the cookie under a success body.
    const sessionRevocation: SessionRevocationStore = {
      isRevoked: () => false,
      async revokeSessionsBefore() {
        throw new Error("disk full");
      },
    };
    const { app } = buildApp({ sessionRevocation });

    const cookie = meCookieIssuedAt(Math.floor(Date.now() / 1000) - 60, 0, 9);
    const response = await fetchLocal(app, "/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });

    assert.ok(
      response.status >= 500 && response.status < 600,
      `expected 5xx, got ${response.status}`,
    );
  });
});

