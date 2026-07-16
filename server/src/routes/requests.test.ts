import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import { requireAuth } from "../middleware/auth";
import {
  SeerrUpstreamError,
  type CreateSeerrRequestInput,
  type SeerrRequest,
} from "../seerr/client";
import { issueSession, SESSION_COOKIE_NAME } from "../session";
import {
  createRequestsRouter,
  type RequestsRouterDeps,
} from "./requests";

const SECRET = "sixteen-chars!!!";
const ADMIN_PERMISSION = 2;

type FakeRes = {
  cookies: Array<{ name: string; value: string }>;
  cookie(name: string, value: string): void;
};

function sessionCookie(permissions = 0, seerrUserId = 7): string {
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
      permissions,
    },
    { secret: SECRET, secure: false },
  );
  return `${SESSION_COOKIE_NAME}=${cookies[0].value}`;
}

function seerrRequest(
  overrides: Partial<SeerrRequest> = {},
): SeerrRequest {
  return {
    id: 12,
    status: 1,
    type: "movie",
    seasons: [],
    createdAt: "2026-07-15T00:00:00.000Z",
    requestedBy: {
      id: 7,
      displayName: "Tyler",
      plexUsername: "tyler",
    },
    media: {
      tmdbId: 603,
      tvdbId: null,
      mediaType: "movie",
      status: 2,
      ratingKey: null,
    },
    ...overrides,
  };
}

function createStubSeerr(
  overrides: Partial<RequestsRouterDeps["seerr"]> = {},
): RequestsRouterDeps["seerr"] & {
  createCalls: CreateSeerrRequestInput[];
  profileCalls: Array<"movie" | "tv">;
  approveCalls: number[];
  declineCalls: number[];
} {
  const createCalls: CreateSeerrRequestInput[] = [];
  const profileCalls: Array<"movie" | "tv"> = [];
  const approveCalls: number[] = [];
  const declineCalls: number[] = [];
  return {
    createCalls,
    profileCalls,
    approveCalls,
    declineCalls,
    async listAllRequests() {
      return [];
    },
    async listUserRequests() {
      return [];
    },
    async getServiceProfiles(mediaType) {
      profileCalls.push(mediaType);
      return {
        serverId: mediaType === "movie" ? 12 : 13,
        defaultProfileId: 1,
        profiles: [{ id: 1, name: "Any" }],
      };
    },
    async createRequest(input) {
      createCalls.push(input);
      return seerrRequest();
    },
    async approveRequest(id) {
      approveCalls.push(id);
      return seerrRequest({ id, status: 2 });
    },
    async declineRequest(id) {
      declineCalls.push(id);
      return seerrRequest({ id, status: 3 });
    },
    ...overrides,
  };
}

function createStubTmdb(): RequestsRouterDeps["tmdb"] & {
  movieCalls: number[];
  tvCalls: number[];
} {
  const movieCalls: number[] = [];
  const tvCalls: number[] = [];
  return {
    movieCalls,
    tvCalls,
    async movieDetail(id) {
      movieCalls.push(id);
      return {
        tmdbId: id,
        mediaType: "movie",
        title: "The Matrix",
        year: 1999,
        overview: "",
        posterUrl: null,
        backdropUrl: null,
        runtime: 136,
        genres: [],
        status: "Released",
        collection: null,
      };
    },
    async tvDetail(id) {
      tvCalls.push(id);
      return {
        tmdbId: id,
        mediaType: "tv",
        title: "Breaking Bad",
        year: 2008,
        overview: "",
        posterUrl: null,
        backdropUrl: null,
        genres: [],
        status: "Ended",
        tvdbId: 81189,
        seasons: [],
      };
    },
  };
}

function createApp(
  seerr: RequestsRouterDeps["seerr"],
  tmdb = createStubTmdb(),
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/requests",
    requireAuth(SECRET),
    createRequestsRouter({ seerr, tmdb, sessionSecret: SECRET }),
  );
  return app;
}

describe("Seerr-backed request routes", () => {
  it("creates a request in Seerr for the authenticated user", async () => {
    const seerr = createStubSeerr();
    const response = await fetchLocal(createApp(seerr), "POST", "/api/requests", {
      cookie: sessionCookie(0, 44),
      body: { tmdbId: 603, mediaType: "movie" },
    });

    assert.equal(response.status, 201);
    assert.deepEqual(seerr.createCalls, [
      { mediaType: "movie", tmdbId: 603, userId: 44 },
    ]);
    assert.deepEqual(await response.json(), {
      id: 12,
      tmdbId: 603,
      mediaType: "movie",
      title: "The Matrix",
      seasons: [],
      requestStatus: "pending",
      mediaStatus: "pending",
      requestedById: 7,
      requestedByName: "Tyler",
      createdAt: "2026-07-15T00:00:00.000Z",
    });
  });

  it("admin-gates quality profiles", async () => {
    const seerr = createStubSeerr();
    const app = createApp(seerr);

    const forbidden = await fetchLocal(
      app,
      "GET",
      "/api/requests/profiles?mediaType=movie",
      { cookie: sessionCookie() },
    );
    assert.equal(forbidden.status, 403);

    const allowed = await fetchLocal(
      app,
      "GET",
      "/api/requests/profiles?mediaType=movie",
      { cookie: sessionCookie(ADMIN_PERMISSION) },
    );
    assert.equal(allowed.status, 200);
    assert.deepEqual(seerr.profileCalls, ["movie"]);
    assert.deepEqual(await allowed.json(), {
      serverId: 12,
      defaultProfileId: 1,
      profiles: [{ id: 1, name: "Any" }],
    });
  });

  it("rejects non-admin profile overrides and forwards admin overrides", async () => {
    const seerr = createStubSeerr();
    const app = createApp(seerr);
    const body = { tmdbId: 603, mediaType: "movie", profileId: 4 };

    const forbidden = await fetchLocal(app, "POST", "/api/requests", {
      cookie: sessionCookie(0, 44),
      body,
    });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(seerr.createCalls, []);
    assert.deepEqual(seerr.profileCalls, []);

    const allowed = await fetchLocal(app, "POST", "/api/requests", {
      cookie: sessionCookie(ADMIN_PERMISSION, 44),
      body,
    });
    assert.equal(allowed.status, 201);
    assert.deepEqual(seerr.profileCalls, ["movie"]);
    assert.deepEqual(seerr.createCalls, [
      {
        mediaType: "movie",
        tmdbId: 603,
        userId: 44,
        profileId: 4,
        serverId: 12,
      },
    ]);
  });

  it("lists only the authenticated user's requests and memoizes titles", async () => {
    let listedUserId: number | undefined;
    const seerr = createStubSeerr({
      async listUserRequests(userId) {
        listedUserId = userId;
        return [seerrRequest({ id: 1 }), seerrRequest({ id: 2 })];
      },
    });
    const tmdb = createStubTmdb();

    const response = await fetchLocal(
      createApp(seerr, tmdb),
      "GET",
      "/api/requests",
      { cookie: sessionCookie(0, 44) },
    );
    const body = (await response.json()) as { results: unknown[] };

    assert.equal(response.status, 200);
    assert.equal(listedUserId, 44);
    assert.equal(body.results.length, 2);
    assert.deepEqual(tmdb.movieCalls, [603]);
  });

  it("requires admin and lists all Seerr requests", async () => {
    let calls = 0;
    const seerr = createStubSeerr({
      async listAllRequests() {
        calls += 1;
        return [seerrRequest()];
      },
    });
    const app = createApp(seerr);

    const forbidden = await fetchLocal(app, "GET", "/api/requests/all", {
      cookie: sessionCookie(),
    });
    assert.equal(forbidden.status, 403);

    const allowed = await fetchLocal(app, "GET", "/api/requests/all", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    assert.equal(allowed.status, 200);
    assert.equal(calls, 1);
  });

  it("approves and declines requests through Seerr for admins", async () => {
    const seerr = createStubSeerr();
    const app = createApp(seerr);
    const options = { cookie: sessionCookie(ADMIN_PERMISSION) };

    const approved = await fetchLocal(
      app,
      "POST",
      "/api/requests/31/approve",
      options,
    );
    const declined = await fetchLocal(
      app,
      "POST",
      "/api/requests/32/decline",
      options,
    );

    assert.equal(approved.status, 200);
    assert.equal(declined.status, 200);
    assert.deepEqual(seerr.approveCalls, [31]);
    assert.deepEqual(seerr.declineCalls, [32]);
    assert.equal(
      ((await approved.json()) as { requestStatus: string }).requestStatus,
      "approved",
    );
    assert.equal(
      ((await declined.json()) as { requestStatus: string }).requestStatus,
      "declined",
    );
  });

  it("maps a Seerr duplicate to 409 and other failures to 502", async () => {
    const duplicate = createStubSeerr({
      async createRequest() {
        throw new SeerrUpstreamError("duplicate", 409);
      },
    });
    const duplicateResponse = await fetchLocal(
      createApp(duplicate),
      "POST",
      "/api/requests",
      {
        cookie: sessionCookie(),
        body: { tmdbId: 603, mediaType: "movie" },
      },
    );
    assert.equal(duplicateResponse.status, 409);

    const unavailable = createStubSeerr({
      async listUserRequests() {
        throw new SeerrUpstreamError("unavailable", 503);
      },
    });
    const unavailableResponse = await fetchLocal(
      createApp(unavailable),
      "GET",
      "/api/requests",
      { cookie: sessionCookie() },
    );
    assert.equal(unavailableResponse.status, 502);
  });
});

async function fetchLocal(
  app: express.Express,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    const headers: Record<string, string> = {};
    if (options.cookie) {
      headers.Cookie = options.cookie;
    }
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
