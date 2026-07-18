import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import type { PlexClient, PlexUser } from "../plex/client";
import {
  SeerrUpstreamError,
  type SeerrClient,
  type SeerrUser,
} from "../seerr/client";
import { SESSION_COOKIE_NAME } from "../session";
import { createAuthRouter } from "./auth";

const SECRET = "sixteen-chars!!!";

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
};

function buildApp(
  overrides: {
    plex?: Partial<PlexClient>;
    seerr?: Partial<SeerrClient>;
  } = {},
): { app: express.Express; calls: Calls } {
  const calls: Calls = { signInTokens: [], getUserPlexIds: [] };

  const plex = {
    async checkPin() {
      return { authToken: "plex-token-abc" };
    },
    async getUser() {
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
    ...overrides.seerr,
  } as unknown as SeerrClient;

  const app = express();
  app.use(express.json());
  app.use(
    "/api/auth",
    createAuthRouter({
      plex,
      seerr,
      sessionSecret: SECRET,
      secureCookies: false,
    }),
  );
  return { app, calls };
}

async function checkPin(
  app: express.Express,
  pinId = "123",
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    return await fetch(
      `http://127.0.0.1:${address.port}/api/auth/plex/check?pinId=${pinId}`,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function sessionCookieValue(response: Response): string | null {
  for (const cookie of response.headers.getSetCookie()) {
    if (cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      return cookie;
    }
  }
  return null;
}

describe("GET /api/auth/plex/check", () => {
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

    const response = await checkPin(app);

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
    assert.deepEqual(calls.signInTokens, ["plex-token-abc"]);
    assert.deepEqual(calls.getUserPlexIds, [100]);

    // A Tyflix session cookie is issued.
    assert.notEqual(sessionCookieValue(response), null);
  });

  it("logs in an existing admin unchanged and never leaks connect.sid", async () => {
    const { app, calls } = buildApp({
      seerr: {
        async signInWithPlex(authToken: string) {
          calls.signInTokens.push(authToken);
          // A divergent Seerr could return a complete user directly.
          return seerrUser({ id: 1, plexId: 100, permissions: 2 });
        },
        async getUserByPlexId(plexId: number) {
          calls.getUserPlexIds.push(plexId);
          return null;
        },
      },
    });

    const response = await checkPin(app);

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: string;
      user: {
        seerrUserId: number;
        plexId: number;
        permissions: number;
        email: string | null;
      };
      isAdmin: boolean;
    };
    assert.equal(body.status, "ok");
    assert.equal(body.user.seerrUserId, 1);
    assert.equal(body.user.permissions, 2);
    assert.equal(body.user.email, "a@example.com");
    assert.equal(body.isAdmin, true);

    // Complete sign-in response short-circuits the lookup.
    assert.deepEqual(calls.getUserPlexIds, []);

    // Only our own cookie is set; Seerr's connect.sid is never forwarded.
    const setCookies = response.headers.getSetCookie();
    assert.equal(
      setCookies.every((c) => !c.toLowerCase().startsWith("connect.sid=")),
      true,
    );
    assert.notEqual(sessionCookieValue(response), null);
  });

  it("rejects a non-member with 403 (not 502) and issues no session", async () => {
    const { app } = buildApp({
      seerr: {
        async signInWithPlex() {
          throw new SeerrUpstreamError("Seerr /api/v1/auth/plex failed (403)", 403);
        },
      },
    });

    const response = await checkPin(app);

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      status: "forbidden",
      message: "Your Plex account isn't a Tyflix member.",
    });
    assert.equal(sessionCookieValue(response), null);
  });

  it("returns 502 for a non-access-denied Seerr failure", async () => {
    const { app } = buildApp({
      seerr: {
        async signInWithPlex() {
          throw new SeerrUpstreamError(
            "Seerr /api/v1/auth/plex failed (500)",
            500,
          );
        },
      },
    });

    const response = await checkPin(app);

    assert.equal(response.status, 502);
    assert.equal(sessionCookieValue(response), null);
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

    const response = await checkPin(app);

    assert.equal(response.status, 403);
    assert.equal(sessionCookieValue(response), null);
  });

  it("returns pending without touching Seerr when no authToken yet", async () => {
    const { app, calls } = buildApp({
      plex: {
        async checkPin() {
          return { authToken: null };
        },
      },
    });

    const response = await checkPin(app);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "pending" });
    assert.deepEqual(calls.signInTokens, []);
  });
});
