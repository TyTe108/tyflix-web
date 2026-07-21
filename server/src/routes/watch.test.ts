import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import { requireAuth } from "../middleware/auth";
import type { PlexConnectionResolver } from "../plex/connection";
import type { PlexEpisode, PlexServerClient } from "../plex/server";
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
    plexServer: {
      async episodes() {
        return [];
      },
      async nextEpisode() {
        return null;
      },
      async playbackMeta() {
        return {
          durationMs: null,
          creditsOffsetMs: null,
          audio: [],
          subtitle: [],
        };
      },
    } as unknown as PlexServerClient,
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
      streams: { audio: unknown[]; subtitle: unknown[] };
      durationMs: number | null;
      creditsOffsetMs: number | null;
    };

    assert.equal(body.mediaType, "movie");
    assert.equal(body.tmdbId, 603);
    assert.equal(body.ratingKey, "12345");
    assert.deepEqual(body.connections, CONNECTIONS);
    assert.equal(body.transient, TRANSIENT);
    assert.deepEqual(body.streams, { audio: [], subtitle: [] });
    assert.equal(body.durationMs, null);
    assert.equal(body.creditsOffsetMs, null);

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

  it("applies valid tuning query params to both HLS URLs", async () => {
    const app = createApp(baseDeps());
    const response = await fetchLocal(
      app,
      "/api/watch/movie/603?maxVideoBitrate=4000&videoResolution=1280x720&offset=90.5&audioStreamID=101",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      hls: { local: string | null; remote: string };
    };
    assert.notEqual(body.hls.local, null);
    const localUrl = body.hls.local as string;

    for (const url of [body.hls.remote, localUrl]) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("maxVideoBitrate"), "4000");
      assert.equal(parsed.searchParams.get("videoResolution"), "1280x720");
      assert.equal(parsed.searchParams.get("offset"), "90.5");
      assert.equal(parsed.searchParams.get("audioStreamID"), "101");
    }
  });

  it("omits tuning keys from HLS URLs when query params are absent", async () => {
    const app = createApp(baseDeps());
    const response = await fetchLocal(
      app,
      "/api/watch/movie/603",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      hls: { local: string | null; remote: string };
    };
    assert.notEqual(body.hls.local, null);
    const localUrl = body.hls.local as string;

    for (const url of [body.hls.remote, localUrl]) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("maxVideoBitrate"), null);
      assert.equal(parsed.searchParams.get("videoResolution"), null);
      assert.equal(parsed.searchParams.get("offset"), null);
      assert.equal(parsed.searchParams.get("audioStreamID"), null);
    }
  });

  it("rejects invalid tuning query params with 400", async () => {
    const app = createApp(baseDeps());
    const cookie = sessionCookie({ plexToken: USER_TOKEN });

    const badBitrate = await fetchLocal(
      app,
      "/api/watch/movie/603?maxVideoBitrate=abc",
      cookie,
    );
    assert.equal(badBitrate.status, 400);
    assert.deepEqual(await badBitrate.json(), {
      error: "maxVideoBitrate must be a positive integer",
    });

    const badOffset = await fetchLocal(
      app,
      "/api/watch/movie/603?offset=-5",
      cookie,
    );
    assert.equal(badOffset.status, 400);
    assert.deepEqual(await badOffset.json(), {
      error: "offset must be a finite number >= 0",
    });

    const badResolution = await fetchLocal(
      app,
      "/api/watch/movie/603?videoResolution=720p",
      cookie,
    );
    assert.equal(badResolution.status, 400);
    assert.deepEqual(await badResolution.json(), {
      error: 'videoResolution must match "WxH" (e.g. "1280x720")',
    });

    const badAudio = await fetchLocal(
      app,
      "/api/watch/movie/603?audioStreamID=",
      cookie,
    );
    assert.equal(badAudio.status, 400);
    assert.deepEqual(await badAudio.json(), {
      error: "audioStreamID must be a non-empty string",
    });
  });
});

describe("GET /api/watch/tv/:tmdbId/episodes", () => {
  it("rejects a non-numeric tmdbId with 400", async () => {
    const app = createApp(baseDeps());
    const response = await fetchLocal(
      app,
      "/api/watch/tv/abc/episodes",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "tmdbId must be numeric" });
  });

  it("returns 404 when the show has no Plex ratingKey", async () => {
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
      "/api/watch/tv/1399/episodes",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not playable" });
  });

  it("returns the episode list for a resolved show ratingKey", async () => {
    const episodes: PlexEpisode[] = [
      {
        ratingKey: "201",
        seasonNumber: 1,
        episodeNumber: 1,
        title: "Pilot",
        thumb: null,
      },
      {
        ratingKey: "202",
        seasonNumber: 1,
        episodeNumber: 2,
        title: "Second",
        thumb: "/library/metadata/202/thumb/1",
      },
    ];
    let ratingKeyArgs: [string, number] | null = null;
    let episodesArg: string | null = null;

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
        return "9000";
      },
    } as MediaStatusProvider;
    deps.plexServer = {
      async episodes(showRatingKey: string) {
        episodesArg = showRatingKey;
        return episodes;
      },
    } as unknown as PlexServerClient;

    const app = createApp(deps);
    const response = await fetchLocal(
      app,
      "/api/watch/tv/1399/episodes",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tmdbId: 1399,
      showRatingKey: "9000",
      episodes,
    });
    assert.deepEqual(ratingKeyArgs, ["tv", 1399]);
    assert.equal(episodesArg, "9000");
  });

  it("returns 502 when the Plex lookup fails upstream", async () => {
    const deps = baseDeps();
    deps.plexServer = {
      async episodes() {
        throw new Error("Plex server allLeaves failed (503)");
      },
    } as unknown as PlexServerClient;

    const app = createApp(deps);
    const response = await fetchLocal(
      app,
      "/api/watch/tv/1399/episodes",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 502);
  });
});

describe("GET /api/watch/episode/:ratingKey/next", () => {
  it("rejects a non-numeric ratingKey with 400", async () => {
    const app = createApp(baseDeps());
    const response = await fetchLocal(
      app,
      "/api/watch/episode/abc/next",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "ratingKey must be numeric",
    });
  });

  it("returns { nextEpisode } for the following episode", async () => {
    let nextArg: string | null = null;
    const nextEpisode = {
      ratingKey: "203",
      seasonNumber: 1,
      episodeNumber: 3,
      title: "Finale",
      thumb: "/library/metadata/203/thumb/1",
    };
    const deps = baseDeps();
    deps.plexServer = {
      async episodes() {
        return [];
      },
      async nextEpisode(episodeRatingKey: string) {
        nextArg = episodeRatingKey;
        return nextEpisode;
      },
      async playbackMeta() {
        return {
          durationMs: null,
          creditsOffsetMs: null,
          audio: [],
          subtitle: [],
        };
      },
    } as unknown as PlexServerClient;

    const app = createApp(deps);
    const response = await fetchLocal(
      app,
      "/api/watch/episode/202/next",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { nextEpisode });
    assert.equal(nextArg, "202");
  });

  it("returns { nextEpisode: null } when there is no next episode", async () => {
    const deps = baseDeps();
    deps.plexServer = {
      async episodes() {
        return [];
      },
      async nextEpisode() {
        return null;
      },
      async playbackMeta() {
        return {
          durationMs: null,
          creditsOffsetMs: null,
          audio: [],
          subtitle: [],
        };
      },
    } as unknown as PlexServerClient;

    const app = createApp(deps);
    const response = await fetchLocal(
      app,
      "/api/watch/episode/203/next",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { nextEpisode: null });
  });
});

describe("GET /api/watch/episode/:ratingKey", () => {
  it("rejects a non-numeric ratingKey with 400", async () => {
    const app = createApp(baseDeps());
    const response = await fetchLocal(
      app,
      "/api/watch/episode/abc",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "ratingKey must be numeric",
    });
  });

  it("returns 409 when the session carries no Plex token", async () => {
    const app = createApp(baseDeps());
    const response = await fetchLocal(
      app,
      "/api/watch/episode/54321",
      sessionCookie(),
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "re-login required" });
  });

  it("returns the episode play descriptor with shared session HLS URLs", async () => {
    let mintedWith: string | null = null;
    const deps = baseDeps();
    deps.transientMinter = {
      async mint(userToken: string) {
        mintedWith = userToken;
        return TRANSIENT;
      },
    } as TransientTokenMinter;

    const app = createApp(deps);
    const response = await fetchLocal(
      app,
      "/api/watch/episode/54321",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      mediaType: string;
      ratingKey: string;
      connections: typeof CONNECTIONS;
      transient: string;
      hls: { local: string | null; remote: string };
      sessionId: string;
      streams: { audio: unknown[]; subtitle: unknown[] };
      durationMs: number | null;
      creditsOffsetMs: number | null;
    };

    assert.equal(body.mediaType, "episode");
    assert.equal(body.ratingKey, "54321");
    assert.deepEqual(body.connections, CONNECTIONS);
    assert.equal(body.transient, TRANSIENT);
    assert.deepEqual(body.streams, { audio: [], subtitle: [] });
    assert.equal(body.durationMs, null);
    assert.equal(body.creditsOffsetMs, null);

    assert.equal(typeof body.sessionId, "string");
    assert.ok(body.sessionId.length > 0);

    // Both HLS URLs are ready-to-play start.m3u8 URLs carrying the raw ratingKey
    // and the SAME shared transcode sessionId.
    assert.ok(
      body.hls.remote.startsWith(`${CONNECTIONS.remote}/video/:/transcode/`),
    );
    assert.ok(body.hls.remote.includes("start.m3u8"));
    assert.ok(body.hls.remote.includes("54321"));
    assert.ok(body.hls.remote.includes(body.sessionId));

    assert.notEqual(body.hls.local, null);
    const localUrl = body.hls.local as string;
    assert.ok(localUrl.startsWith(`${CONNECTIONS.local}/video/:/transcode/`));
    assert.ok(localUrl.includes("start.m3u8"));
    assert.ok(localUrl.includes("54321"));
    assert.ok(localUrl.includes(body.sessionId));

    // The descriptor mints from the recovered durable token.
    assert.equal(mintedWith, USER_TOKEN);
  });

  it("applies valid tuning query params to both HLS URLs", async () => {
    const app = createApp(baseDeps());
    const response = await fetchLocal(
      app,
      "/api/watch/episode/54321?maxVideoBitrate=2000&videoResolution=1920x1080&offset=0&audioStreamID=101",
      sessionCookie({ plexToken: USER_TOKEN }),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      hls: { local: string | null; remote: string };
    };
    assert.notEqual(body.hls.local, null);
    const localUrl = body.hls.local as string;

    for (const url of [body.hls.remote, localUrl]) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("maxVideoBitrate"), "2000");
      assert.equal(parsed.searchParams.get("videoResolution"), "1920x1080");
      assert.equal(parsed.searchParams.get("offset"), "0");
      assert.equal(parsed.searchParams.get("audioStreamID"), "101");
    }
  });

  it("rejects invalid tuning query params with 400", async () => {
    const app = createApp(baseDeps());
    const cookie = sessionCookie({ plexToken: USER_TOKEN });

    const badBitrate = await fetchLocal(
      app,
      "/api/watch/episode/54321?maxVideoBitrate=0",
      cookie,
    );
    assert.equal(badBitrate.status, 400);
    assert.deepEqual(await badBitrate.json(), {
      error: "maxVideoBitrate must be a positive integer",
    });

    const badAudio = await fetchLocal(
      app,
      "/api/watch/episode/54321?audioStreamID=",
      cookie,
    );
    assert.equal(badAudio.status, 400);
    assert.deepEqual(await badAudio.json(), {
      error: "audioStreamID must be a non-empty string",
    });
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
