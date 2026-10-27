import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import express from "express";
import { requireAuth } from "../middleware/auth";
import { clearPermissionCacheForTests } from "../middleware/revalidatePermissions";
import {
  SeerrUpstreamError,
  type CreateSeerrRequestInput,
  type SeerrRequest,
  type SeerrUser,
} from "../seerr/client";
import { issueSession, SESSION_COOKIE_NAME } from "../session";
import {
  TmdbUpstreamError,
  type MovieDetail,
  type TmdbClient,
  type TvDetail,
} from "../tmdb/client";
import { createMediaEnrichment } from "../tmdb/enrichment";
import {
  createRequestsRouter,
  type RequestsRouterDeps,
} from "./requests";

const SECRET = "sixteen-chars!!!";
const ADMIN_PERMISSION = 2;

// sessionCookie registers the permissions Seerr should report for that user so
// existing admin-gate cases keep working after live revalidation.
const livePermissions = new Map<number, number>();

beforeEach(() => {
  clearPermissionCacheForTests();
  livePermissions.clear();
});

type FakeRes = {
  cookies: Array<{ name: string; value: string }>;
  cookie(name: string, value: string): void;
};

function sessionCookie(permissions = 0, seerrUserId = 7): string {
  livePermissions.set(seerrUserId, permissions);
  clearPermissionCacheForTests();
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

function liveSeerrUser(id: number): SeerrUser {
  return {
    id,
    plexId: 10,
    plexUsername: "tyler",
    displayName: "Tyler",
    email: null,
    permissions: livePermissions.get(id) ?? 0,
  };
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
    updatedAt: "2026-07-15T01:00:00.000Z",
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
    async getUserById(id: number) {
      return liveSeerrUser(id);
    },
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

function titledRequest(
  id: number,
  type: "movie" | "tv",
  tmdbId: number,
  status = 1,
): SeerrRequest {
  return seerrRequest({
    id,
    status,
    type,
    media: {
      tmdbId,
      tvdbId: null,
      mediaType: type,
      status: 2,
      ratingKey: null,
    },
  });
}

function posterFor(type: "movie" | "tv", id: number): string {
  return `https://posters.test/${type}/${id}.jpg`;
}

function createTitledTmdb(failing = new Set<string>()): {
  calls: string[];
  failing: Set<string>;
  movieDetail(id: number): Promise<MovieDetail>;
  tvDetail(id: number): Promise<TvDetail>;
} {
  const calls: string[] = [];

  function rejectIfFailing(key: string, id: number, type: "movie" | "tv"): void {
    if (!failing.has(key)) {
      return;
    }
    const path = type === "movie" ? `/movie/${id}` : `/tv/${id}`;
    throw new TmdbUpstreamError(`TMDB ${path} failed (429)`, 429);
  }

  return {
    calls,
    failing,
    async movieDetail(id) {
      const key = `movie:${id}`;
      calls.push(key);
      rejectIfFailing(key, id, "movie");
      return {
        tmdbId: id,
        mediaType: "movie",
        title: `Stub Movie ${id}`,
        year: null,
        overview: "",
        posterUrl: posterFor("movie", id),
        backdropUrl: null,
        runtime: null,
        genres: [],
        status: "",
        collection: null,
      };
    },
    async tvDetail(id) {
      const key = `tv:${id}`;
      calls.push(key);
      rejectIfFailing(key, id, "tv");
      return {
        tmdbId: id,
        mediaType: "tv",
        title: `Stub Show ${id}`,
        year: null,
        overview: "",
        posterUrl: posterFor("tv", id),
        backdropUrl: null,
        genres: [],
        status: "",
        tvdbId: null,
        seasons: [],
      };
    },
  };
}

function createStubTmdb(): Pick<TmdbClient, "movieDetail" | "tvDetail"> & {
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
  tmdb: Pick<TmdbClient, "movieDetail" | "tvDetail"> = createStubTmdb(),
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/requests",
    requireAuth(SECRET, seerr, { isRevoked: () => false }),
    createRequestsRouter({
      seerr,
      mediaEnrichment: createMediaEnrichment(tmdb),
      sessionSecret: SECRET,
      sessionRevocation: { isRevoked: () => false },
    }),
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
      posterUrl: null,
      seasons: [],
      requestStatus: "pending",
      mediaStatus: "pending",
      requestedById: 7,
      requestedByName: "Tyler",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T01:00:00.000Z",
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

describe("degraded TMDB titles on request routes", () => {
  const threeRequests = [
    titledRequest(1, "movie", 100),
    titledRequest(2, "movie", 200),
    titledRequest(3, "movie", 300),
  ];

  async function listResponse(
    method: "user" | "all",
    tmdb: ReturnType<typeof createTitledTmdb>,
    requests: SeerrRequest[],
  ): Promise<Response> {
    const seerr = createStubSeerr(
      method === "all"
        ? {
            async listAllRequests() {
              return requests;
            },
          }
        : {
            async listUserRequests() {
              return requests;
            },
          },
    );
    return fetchLocal(
      createApp(seerr, tmdb),
      "GET",
      method === "all" ? "/api/requests/all" : "/api/requests",
      {
        cookie: sessionCookie(
          method === "all" ? ADMIN_PERMISSION : 0,
        ),
      },
    );
  }

  it("GET /all returns every request when one TMDB lookup fails", async () => {
    const response = await listResponse(
      "all",
      createTitledTmdb(new Set(["movie:300"])),
      threeRequests,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      results: Array<{ title: string; posterUrl: string | null }>;
    };
    assert.equal(body.results.length, 3);
    assert.deepEqual(
      body.results.map((row) => ({ title: row.title, posterUrl: row.posterUrl })),
      [
        { title: "Stub Movie 100", posterUrl: posterFor("movie", 100) },
        { title: "Stub Movie 200", posterUrl: posterFor("movie", 200) },
        { title: "Title unavailable (movie 300)", posterUrl: null },
      ],
    );
  });

  it("GET / returns every request when one TMDB lookup fails", async () => {
    const response = await listResponse(
      "user",
      createTitledTmdb(new Set(["movie:300"])),
      threeRequests,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      results: Array<{ title: string; posterUrl: string | null }>;
    };
    assert.equal(body.results.length, 3);
    assert.deepEqual(
      body.results.map((row) => ({ title: row.title, posterUrl: row.posterUrl })),
      [
        { title: "Stub Movie 100", posterUrl: posterFor("movie", 100) },
        { title: "Stub Movie 200", posterUrl: posterFor("movie", 200) },
        { title: "Title unavailable (movie 300)", posterUrl: null },
      ],
    );
  });

  it("GET /all returns placeholders when every TMDB lookup fails", async () => {
    const response = await listResponse(
      "all",
      createTitledTmdb(new Set(["movie:100", "movie:200", "movie:300"])),
      threeRequests,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      results: Array<{ title: string; posterUrl: string | null }>;
    };
    assert.deepEqual(
      body.results.map((row) => ({ title: row.title, posterUrl: row.posterUrl })),
      [
        { title: "Title unavailable (movie 100)", posterUrl: null },
        { title: "Title unavailable (movie 200)", posterUrl: null },
        { title: "Title unavailable (movie 300)", posterUrl: null },
      ],
    );
  });

  it("gives a movie and a show that share a tmdbId their own titles", async () => {
    const tmdb = createTitledTmdb();
    const response = await listResponse("all", tmdb, [
      titledRequest(1, "movie", 100),
      titledRequest(2, "tv", 100),
    ]);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { results: Array<{ title: string }> };
    assert.deepEqual(
      body.results.map((row) => row.title),
      ["Stub Movie 100", "Stub Show 100"],
    );
    assert.deepEqual(tmdb.calls, ["movie:100", "tv:100"]);
  });

  it("retries only a failed lookup on the next GET /all", async () => {
    const failing = new Set(["movie:300"]);
    const tmdb = createTitledTmdb(failing);
    const seerr = createStubSeerr({
      async listAllRequests() {
        return threeRequests;
      },
    });
    const app = createApp(seerr, tmdb);
    const cookie = sessionCookie(ADMIN_PERMISSION);

    const first = await fetchLocal(app, "GET", "/api/requests/all", { cookie });
    assert.equal(first.status, 200);
    assert.deepEqual(tmdb.calls, ["movie:100", "movie:200", "movie:300"]);

    const second = await fetchLocal(app, "GET", "/api/requests/all", { cookie });
    assert.equal(second.status, 200);
    assert.deepEqual(tmdb.calls, [
      "movie:100",
      "movie:200",
      "movie:300",
      "movie:300",
    ]);

    failing.clear();
    const third = await fetchLocal(app, "GET", "/api/requests/all", { cookie });
    assert.equal(third.status, 200);
    assert.deepEqual(tmdb.calls, [
      "movie:100",
      "movie:200",
      "movie:300",
      "movie:300",
      "movie:300",
    ]);
    const body = (await third.json()) as {
      results: Array<{ title: string; posterUrl: string | null }>;
    };
    assert.equal(body.results[2].title, "Stub Movie 300");
    assert.equal(body.results[2].posterUrl, posterFor("movie", 300));
  });

  it("POST returns 201 with a placeholder after Seerr has accepted the request", async () => {
    const seerr = createStubSeerr();
    seerr.createRequest = async (input) => {
      seerr.createCalls.push(input);
      return titledRequest(12, "movie", 300);
    };
    const response = await fetchLocal(
      createApp(seerr, createTitledTmdb(new Set(["movie:300"]))),
      "POST",
      "/api/requests",
      {
        cookie: sessionCookie(0, 44),
        body: { tmdbId: 300, mediaType: "movie" },
      },
    );
    assert.equal(response.status, 201);
    assert.equal(seerr.createCalls.length, 1);
    const body = (await response.json()) as {
      title: string;
      posterUrl: string | null;
    };
    assert.equal(body.title, "Title unavailable (movie 300)");
    assert.equal(body.posterUrl, null);
  });

  it("approve and decline return the new status with a placeholder title", async () => {
    const seerr = createStubSeerr();
    seerr.approveRequest = async (id) => {
      seerr.approveCalls.push(id);
      return titledRequest(id, "movie", 300, 2);
    };
    seerr.declineRequest = async (id) => {
      seerr.declineCalls.push(id);
      return titledRequest(id, "movie", 300, 3);
    };
    const app = createApp(seerr, createTitledTmdb(new Set(["movie:300"])));
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
    const approvedBody = (await approved.json()) as {
      requestStatus: string;
      title: string;
    };
    const declinedBody = (await declined.json()) as {
      requestStatus: string;
      title: string;
    };
    assert.equal(approvedBody.requestStatus, "approved");
    assert.equal(declinedBody.requestStatus, "declined");
    assert.equal(approvedBody.title, "Title unavailable (movie 300)");
    assert.equal(declinedBody.title, "Title unavailable (movie 300)");
  });

  it("still returns 502 when Seerr fails or a request status is unknown", async () => {
    const unavailable = createStubSeerr({
      async listAllRequests() {
        throw new SeerrUpstreamError("unavailable", 503);
      },
    });
    const unavailableResponse = await fetchLocal(
      createApp(unavailable, createTitledTmdb()),
      "GET",
      "/api/requests/all",
      { cookie: sessionCookie(ADMIN_PERMISSION) },
    );
    assert.equal(unavailableResponse.status, 502);
    assert.deepEqual(await unavailableResponse.json(), { error: "unavailable" });

    const unknown = createStubSeerr({
      async listAllRequests() {
        return [titledRequest(9, "movie", 100, 99)];
      },
    });
    const unknownResponse = await fetchLocal(
      createApp(unknown, createTitledTmdb()),
      "GET",
      "/api/requests/all",
      { cookie: sessionCookie(ADMIN_PERMISSION) },
    );
    assert.equal(unknownResponse.status, 502);
  });
});

async function fetchLocal(
  app: express.Express,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<Response> {
  // On macOS a wildcard listen on port 0 can share a port another app holds on 127.0.0.1, and the request then goes to that app (HANDOFF §9).
  const server = app.listen(0, "127.0.0.1");
  // Node binds on the next tick when a host is passed, so address() is null
  // until listening fires.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      resolve();
    });
  });
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
