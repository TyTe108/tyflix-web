import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import { requireAuth } from "../middleware/auth";
import type { PlexConnectionResolver } from "../plex/connection";
import type { TransientTokenMinter } from "../plex/transientToken";
import type { MediaStatusProvider } from "../seerr/mediaStatusProvider";
import { issueSession, SESSION_COOKIE_NAME } from "../session";
import { createWatchRouter, type WatchRouterDeps } from "./watch";

const SECRET = "sixteen-chars!!!";
const USER_TOKEN = "user-durable-token";
const TRANSIENT = "transient-24b68e46-3eb5-449e-8295-ff59e9a5e6cb";
const CLIENT_ID = "client-id-1";
const CONNECTIONS = {
  local: "https://10-0-0-10.machine-abc.plex.direct:32400",
  remote: "https://1-2-3-4.machine-abc.plex.direct:32400",
};

function sessionCookie(opts: { plexToken?: string } = {}): string {
  const cookies: Array<{ name: string; value: string }> = [];
  const res = {
    cookie(name: string, value: string) {
      cookies.push({ name, value });
    },
  };
  issueSession(
    res as unknown as import("express").Response,
    {
      seerrUserId: 7,
      plexId: 10,
      plexUsername: "tyler",
      displayName: "Tyler",
      avatar: null,
      permissions: 0,
      ...(opts.plexToken !== undefined ? { plexToken: opts.plexToken } : {}),
    },
    { secret: SECRET, secure: false },
  );
  return `${SESSION_COOKIE_NAME}=${cookies[0].value}`;
}

function baseDeps(): WatchRouterDeps {
  return {
    sessionSecret: SECRET,
    plexClientId: CLIENT_ID,
    mediaStatus: {
      async getStatusMap() {
        return new Map();
      },
      async getMediaId() {
        return null;
      },
      async getRatingKey() {
        return "12345";
      },
    } as MediaStatusProvider,
    transientMinter: {
      async mint() {
        return TRANSIENT;
      },
    } as TransientTokenMinter,
    plexConnection: {
      async resolveConnections() {
        return CONNECTIONS;
      },
    } as PlexConnectionResolver,
  };
}

function createApp(deps: WatchRouterDeps): express.Express {
  const app = express();
  app.use("/api/watch", requireAuth(SECRET), createWatchRouter(deps));
  return app;
}

describe("GET /api/watch/movie/:tmdbId", () => {
  it("rejects a non-numeric tmdbId with 400", async () => {
    const app = createApp(baseDeps());
    const response = await fetchLocal(
      app,
      "/api/watch/movie/abc",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 400);
  });

  it("returns 409 when the session carries no Plex token", async () => {
    const app = createApp(baseDeps());
    const response = await fetchLocal(
      app,
      "/api/watch/movie/603",
      sessionCookie(),
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "re-login required" });
  });

  it("returns 404 when the title has no Plex ratingKey", async () => {
    const deps = baseDeps();
    deps.mediaStatus = {
      async getStatusMap() {
        return new Map();
      },
      async getMediaId() {
        return null;
      },
      async getRatingKey() {
        return null;
      },
    } as MediaStatusProvider;

    const app = createApp(deps);
    const response = await fetchLocal(
      app,
      "/api/watch/movie/603",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not playable" });
  });

  it("returns the play descriptor with the full transient on the happy path", async () => {
    let mintedWith: string | null = null;
    let ratingKeyArgs: [string, number] | null = null;
    const deps = baseDeps();
    deps.mediaStatus = {
      async getStatusMap() {
        return new Map();
      },
      async getMediaId() {
        return null;
      },
      async getRatingKey(mediaType: "movie" | "tv", tmdbId: number) {
        ratingKeyArgs = [mediaType, tmdbId];
        return "12345";
      },
    } as MediaStatusProvider;
    deps.transientMinter = {
      async mint(userToken: string) {
        mintedWith = userToken;
        return TRANSIENT;
      },
    } as TransientTokenMinter;

    const app = createApp(deps);
    const response = await fetchLocal(
      app,
      "/api/watch/movie/603",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      mediaType: string;
      tmdbId: number;
      ratingKey: string;
      connections: typeof CONNECTIONS;
      transient: string;
      hls: { local: string | null; remote: string };
      sessionId: string;
    };

    assert.equal(body.mediaType, "movie");
    assert.equal(body.tmdbId, 603);
    assert.equal(body.ratingKey, "12345");
    assert.deepEqual(body.connections, CONNECTIONS);
    assert.equal(body.transient, TRANSIENT);

    // sessionId is present and both HLS URLs are ready-to-play start.m3u8 URLs
    // carrying the ratingKey.
    assert.equal(typeof body.sessionId, "string");
    assert.ok(body.sessionId.length > 0);

    assert.ok(
      body.hls.remote.startsWith(`${CONNECTIONS.remote}/video/:/transcode/`),
    );
    assert.ok(body.hls.remote.includes("start.m3u8"));
    assert.ok(body.hls.remote.includes("12345"));

    assert.notEqual(body.hls.local, null);
    const localUrl = body.hls.local as string;
    assert.ok(localUrl.startsWith(`${CONNECTIONS.local}/video/:/transcode/`));
    assert.ok(localUrl.includes("start.m3u8"));
    assert.ok(localUrl.includes("12345"));

    // The SAME sessionId must appear in both HLS URLs.
    assert.ok(body.hls.remote.includes(body.sessionId));
    assert.ok(localUrl.includes(body.sessionId));

    // The recovered durable token is what we mint from.
    assert.equal(mintedWith, USER_TOKEN);
    assert.deepEqual(ratingKeyArgs, ["movie", 603]);
  });

  it("sets hls.local to null when the server advertises no local connection", async () => {
    const deps = baseDeps();
    deps.plexConnection = {
      async resolveConnections() {
        return { local: null, remote: CONNECTIONS.remote };
      },
    } as PlexConnectionResolver;

    const app = createApp(deps);
    const response = await fetchLocal(
      app,
      "/api/watch/movie/603",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      connections: { local: string | null; remote: string };
      hls: { local: string | null; remote: string };
      sessionId: string;
    };

    assert.equal(body.connections.local, null);
    assert.equal(body.hls.local, null);
    assert.ok(body.hls.remote.includes("start.m3u8"));
    assert.ok(body.hls.remote.includes(body.sessionId));
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
