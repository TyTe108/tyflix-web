import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import express from "express";
import { closeDatabase, openDatabase } from "../db";
import { getRequestById, listAllRequests } from "../db/requests";
import { requireAuth } from "../middleware/auth";
import type { RadarrClient } from "../radarr/client";
import {
  SEERR_PERM_ADMIN,
  SEERR_PERM_AUTO_APPROVE_MOVIE,
} from "../requests/autoApprove";
import type { SonarrClient } from "../sonarr/client";
import { issueSession, SESSION_COOKIE_NAME } from "../session";
import type { TmdbClient } from "../tmdb/client";
import { createRequestsRouter } from "./requests";

const SECRET = "sixteen-chars!!!";

type FakeRes = {
  cookies: Array<{ name: string; value: string }>;
  cookie(name: string, value: string): void;
};

function fakeRes(): FakeRes {
  const cookies: Array<{ name: string; value: string }> = [];
  return {
    cookies,
    cookie(name: string, value: string) {
      cookies.push({ name, value });
    },
  };
}

function sessionCookie(
  permissions: number,
  seerrUserId = 1,
): string {
  const res = fakeRes();
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
  return `${SESSION_COOKIE_NAME}=${res.cookies[0].value}`;
}

function createStubTmdb(): TmdbClient & {
  movieDetailCalls: number[];
} {
  const movieDetailCalls: number[] = [];
  return {
    movieDetailCalls,
    async search() {
      return { page: 1, totalPages: 1, results: [] };
    },
    async trending() {
      return [];
    },
    async movieDetail(id: number) {
      movieDetailCalls.push(id);
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
      };
    },
    async tvDetail(id: number) {
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
        seasons: [{ seasonNumber: 1, name: "Season 1", episodeCount: 7 }],
      };
    },
  };
}

function createStubRadarr(): RadarrClient & { addMovieCalls: unknown[] } {
  const addMovieCalls: unknown[] = [];
  return {
    addMovieCalls,
    async getMovieByTmdbId() {
      throw new Error("not used");
    },
    async addMovie(opts) {
      addMovieCalls.push(opts);
      return {
        id: 42,
        title: opts.title,
        tmdbId: opts.tmdbId,
        hasFile: false,
        monitored: true,
      };
    },
    async searchMovie() {},
  };
}

function createStubSonarr(): SonarrClient {
  return {
    async getSeriesByTvdbId() {
      throw new Error("not used");
    },
    async addSeries() {
      return {
        id: 99,
        title: "Breaking Bad",
        tvdbId: 81189,
        monitored: true,
        seasons: [],
      };
    },
    async searchSeries() {},
  };
}

const processConfig = {
  radarrQualityProfileId: 4,
  radarrRootFolder: "/movies",
  radarrMinimumAvailability: "released",
  sonarrQualityProfileId: 5,
  sonarrRootFolder: "/tv",
  sonarrLanguageProfileId: null as number | null,
};

describe("POST /api/requests", () => {
  let tmdb: ReturnType<typeof createStubTmdb>;
  let radarr: ReturnType<typeof createStubRadarr>;
  let app: express.Express;

  beforeEach(() => {
    openDatabase(":memory:");
    tmdb = createStubTmdb();
    radarr = createStubRadarr();
    app = express();
    app.use(express.json());
    app.use(
      "/api/requests",
      requireAuth(SECRET),
      createRequestsRouter({
        tmdb,
        radarr,
        sonarr: createStubSonarr(),
        config: processConfig,
        sessionSecret: SECRET,
      }),
    );
  });

  afterEach(() => {
    closeDatabase();
  });

  it("admin request auto-approves, calls addMovie, stores approved/processing", async () => {
    const res = await fetchLocal(app, "POST", "/api/requests", {
      cookie: sessionCookie(SEERR_PERM_ADMIN),
      body: { tmdbId: 603, mediaType: "movie" },
    });

    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      requestStatus: string;
      mediaStatus: string;
      radarrId: number | null;
      title: string;
    };
    assert.equal(body.requestStatus, "approved");
    assert.equal(body.mediaStatus, "processing");
    assert.equal(body.radarrId, 42);
    assert.equal(body.title, "The Matrix");
    assert.equal(radarr.addMovieCalls.length, 1);
    assert.deepEqual(radarr.addMovieCalls[0], {
      tmdbId: 603,
      title: "The Matrix",
      year: 1999,
      qualityProfileId: 4,
      rootFolderPath: "/movies",
      minimumAvailability: "released",
    });

    const stored = listAllRequests();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].requestStatus, "approved");
    assert.equal(stored[0].mediaStatus, "processing");
  });

  it("non-privileged request stores pending and does not call addMovie", async () => {
    const res = await fetchLocal(app, "POST", "/api/requests", {
      cookie: sessionCookie(0),
      body: { tmdbId: 603, mediaType: "movie" },
    });

    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      requestStatus: string;
      mediaStatus: string;
      radarrId: number | null;
    };
    assert.equal(body.requestStatus, "pending");
    assert.equal(body.mediaStatus, "unknown");
    assert.equal(body.radarrId, null);
    assert.equal(radarr.addMovieCalls.length, 0);
  });

  it("AUTO_APPROVE_MOVIE bit auto-approves movies", async () => {
    const res = await fetchLocal(app, "POST", "/api/requests", {
      cookie: sessionCookie(SEERR_PERM_AUTO_APPROVE_MOVIE),
      body: { tmdbId: 603, mediaType: "movie" },
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { requestStatus: string };
    assert.equal(body.requestStatus, "approved");
    assert.equal(radarr.addMovieCalls.length, 1);
  });

  it("returns 409 on duplicate active request", async () => {
    const cookie = sessionCookie(0);
    const first = await fetchLocal(app, "POST", "/api/requests", {
      cookie,
      body: { tmdbId: 603, mediaType: "movie" },
    });
    assert.equal(first.status, 201);

    const second = await fetchLocal(app, "POST", "/api/requests", {
      cookie,
      body: { tmdbId: 603, mediaType: "movie" },
    });
    assert.equal(second.status, 409);
    const body = (await second.json()) as {
      error: string;
      request: { tmdbId: number };
    };
    assert.equal(body.error, "already requested");
    assert.equal(body.request.tmdbId, 603);
    assert.equal(listAllRequests().length, 1);
  });

  it("returns 401 without a session", async () => {
    const res = await fetchLocal(app, "POST", "/api/requests", {
      body: { tmdbId: 603, mediaType: "movie" },
    });
    assert.equal(res.status, 401);
  });
});

describe("POST /api/requests/:id/approve", () => {
  let radarr: ReturnType<typeof createStubRadarr>;
  let app: express.Express;

  beforeEach(() => {
    openDatabase(":memory:");
    radarr = createStubRadarr();
    app = express();
    app.use(express.json());
    app.use(
      "/api/requests",
      requireAuth(SECRET),
      createRequestsRouter({
        tmdb: createStubTmdb(),
        radarr,
        sonarr: createStubSonarr(),
        config: processConfig,
        sessionSecret: SECRET,
      }),
    );
  });

  afterEach(() => {
    closeDatabase();
  });

  it("admin can approve a pending request and trigger Radarr", async () => {
    const createRes = await fetchLocal(app, "POST", "/api/requests", {
      cookie: sessionCookie(0, 7),
      body: { tmdbId: 603, mediaType: "movie" },
    });
    const created = (await createRes.json()) as { id: number };
    assert.equal(radarr.addMovieCalls.length, 0);

    const approveRes = await fetchLocal(
      app,
      "POST",
      `/api/requests/${created.id}/approve`,
      { cookie: sessionCookie(SEERR_PERM_ADMIN, 1) },
    );
    assert.equal(approveRes.status, 200);
    const body = (await approveRes.json()) as {
      requestStatus: string;
      mediaStatus: string;
      radarrId: number;
      decidedBy: number;
    };
    assert.equal(body.requestStatus, "approved");
    assert.equal(body.mediaStatus, "processing");
    assert.equal(body.radarrId, 42);
    assert.equal(body.decidedBy, 1);
    assert.equal(radarr.addMovieCalls.length, 1);

    const stored = getRequestById(created.id);
    assert.equal(stored?.requestStatus, "approved");
  });

  it("returns 403 for non-admin approve", async () => {
    const createRes = await fetchLocal(app, "POST", "/api/requests", {
      cookie: sessionCookie(0),
      body: { tmdbId: 603, mediaType: "movie" },
    });
    const created = (await createRes.json()) as { id: number };

    const approveRes = await fetchLocal(
      app,
      "POST",
      `/api/requests/${created.id}/approve`,
      { cookie: sessionCookie(0) },
    );
    assert.equal(approveRes.status, 403);
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
