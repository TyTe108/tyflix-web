import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import { requireAuth } from "../middleware/auth";
import type { PlexServerClient } from "../plex/server";
import type { SeerrClient, UserQuota } from "../seerr/client";
import { issueSession, SESSION_COOKIE_NAME } from "../session";
import { createMeRouter } from "./me";

const SECRET = "sixteen-chars!!!";

type FakeRes = {
  cookies: Array<{ name: string; value: string }>;
  cookie(name: string, value: string): void;
};

function sessionCookie(seerrUserId: number): string {
  const cookies: Array<{ name: string; value: string }> = [];
  const res: FakeRes = {
    cookies,
    cookie(name, value) {
      cookies.push({ name, value });
    },
  };
  issueSession(
    res as unknown as import("express").Response,
    {
      seerrUserId,
      plexId: 10,
      plexUsername: "tyler",
      displayName: "Tyler",
      avatar: null,
      permissions: 0,
    },
    { secret: SECRET, secure: false },
  );
  return `${SESSION_COOKIE_NAME}=${cookies[0].value}`;
}

describe("GET /api/me/quota", () => {
  it("returns the authenticated session user's quota", async () => {
    const quota: UserQuota = {
      movie: { days: 7, limit: 5, used: 2, restricted: false },
      tv: { days: 30, limit: 0, used: 0, restricted: false },
    };
    const userIds: number[] = [];
    const seerr = {
      async getUserQuota(userId: number) {
        userIds.push(userId);
        return quota;
      },
    } as SeerrClient;

    const app = express();
    app.use(
      "/api/me",
      requireAuth(SECRET),
      createMeRouter({
        seerr,
        plexServer: {} as PlexServerClient,
      }),
    );

    const response = await fetchLocal(app, "/api/me/quota", sessionCookie(44));

    assert.equal(response.status, 200);
    assert.deepEqual(userIds, [44]);
    assert.deepEqual(await response.json(), quota);
  });
});

async function fetchLocal(
  app: express.Express,
  path: string,
  cookie: string,
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: { Cookie: cookie },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
