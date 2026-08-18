import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import express from "express";
import type {
  AccessRequest,
  AccessRequestStatus,
} from "../accessRequests/store";
import { requireAuth } from "../middleware/auth";
import { clearPermissionCacheForTests } from "../middleware/revalidatePermissions";
import type { PlexServerClient } from "../plex/server";
import type {
  SeerrClient,
  SeerrRequest,
  UserQuota,
} from "../seerr/client";
import type { IssueStatus, IssueView } from "../seerr/issues";
import { issueSession, SESSION_COOKIE_NAME } from "../session";
import type { UserPreferencesStore } from "../preferences/store";
import { createMeRouter } from "./me";

const SECRET = "sixteen-chars!!!";

beforeEach(() => {
  clearPermissionCacheForTests();
});

const defaultPreferences: UserPreferencesStore = {
  get: () => ({ fullscreenOnPlay: true }),
  async set(_id, patch) {
    return { fullscreenOnPlay: true, ...patch };
  },
};

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
      async getUserById(id: number) {
        return {
          id,
          plexId: 10,
          plexUsername: "tyler",
          displayName: "Tyler",
          email: null,
          permissions: 0,
        };
      },
    } as SeerrClient;

    const app = express();
    app.use(
      "/api/me",
      requireAuth(SECRET, seerr, { isRevoked: () => false }),
      createMeRouter({
        seerr,
        plexServer: {} as PlexServerClient,
        preferences: defaultPreferences,
      }),
    );

    const response = await fetchLocal(app, "/api/me/quota", sessionCookie(44));

    assert.equal(response.status, 200);
    assert.deepEqual(userIds, [44]);
    assert.deepEqual(await response.json(), quota);
  });
});

describe("GET /api/me/badge-counts", () => {
  it("returns only the caller's active requests and open issues for a non-admin", async () => {
    const fixture = createBadgeApp({
      permissions: 0,
      ownRequests: [
        requestRow(1, 5, 1),
        requestRow(2, 3, 2),
        requestRow(2, 2, 3),
        requestRow(2, 1, 4),
        requestRow(2, 4, 5),
        requestRow(2, 5, 6),
        requestRow(3, 3, 7),
        requestRow(4, 3, 8),
        requestRow(2, 7, 9),
        requestRow(2, 6, 10),
        requestRow(5, 3, 11),
      ],
      issues: [
        issueRow(44, "open", 1),
        issueRow(44, "resolved", 2),
        issueRow(99, "open", 3),
      ],
    });

    const response = await fetchLocal(
      fixture.app,
      "/api/me/badge-counts",
      sessionCookie(44),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      mine: { requests: 1, issues: 1 },
      admin: null,
    });
    assert.equal(fixture.issueCalls(), 1);
    assert.equal(fixture.allRequestCalls(), 0);
  });

  it("returns all admin counts using live permissions and one issue-list call", async () => {
    const fixture = createBadgeApp({
      permissions: 2,
      ownRequests: [
        requestRow(1, 5, 1),
        requestRow(2, 3, 2),
        requestRow(3, 3, 3),
      ],
      allRequests: [
        requestRow(1, 5, 10),
        requestRow(1, 1, 11),
        requestRow(2, 3, 12),
      ],
      issues: [
        issueRow(44, "open", 1),
        issueRow(99, "open", 2),
        issueRow(44, "resolved", 3),
      ],
      accessRequests: [
        accessRequestRow("pending", "a"),
        accessRequestRow("pending", "b"),
        accessRequestRow("denied", "c"),
      ],
    });

    const response = await fetchLocal(
      fixture.app,
      "/api/me/badge-counts",
      sessionCookie(44),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      mine: { requests: 1, issues: 1 },
      admin: { requests: 2, issues: 2, access: 2 },
    });
    assert.equal(fixture.issueCalls(), 1);
    assert.equal(fixture.allRequestCalls(), 1);
  });

  it("returns zero admin access requests when the optional store is absent", async () => {
    const fixture = createBadgeApp({
      permissions: 2,
      ownRequests: [],
      allRequests: [],
      issues: [],
    });

    const response = await fetchLocal(
      fixture.app,
      "/api/me/badge-counts",
      sessionCookie(44),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      mine: { requests: 0, issues: 0 },
      admin: { requests: 0, issues: 0, access: 0 },
    });
  });

  it("returns 401 without a session cookie", async () => {
    const fixture = createBadgeApp({
      permissions: 0,
      ownRequests: [],
      issues: [],
    });

    // requireAuth answers before routing; the authenticated 200 tests above
    // are what prove the badge-counts route itself exists.
    const response = await fetchLocal(
      fixture.app,
      "/api/me/badge-counts",
      "",
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "not authenticated" });
  });

  it("returns 502 when Seerr rejects a badge list request", async () => {
    const fixture = createBadgeApp({
      permissions: 0,
      ownRequests: [],
      issues: [],
      rejectOwnRequests: true,
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(
        fixture.app,
        "/api/me/badge-counts",
        sessionCookie(44),
      );

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: "Seerr failed" });
    } finally {
      console.error = originalConsoleError;
    }
  });
});

function createBadgeApp(options: {
  permissions: number;
  ownRequests: SeerrRequest[];
  allRequests?: SeerrRequest[];
  issues: IssueView[];
  accessRequests?: AccessRequest[];
  rejectOwnRequests?: boolean;
}): {
  app: express.Express;
  issueCalls(): number;
  allRequestCalls(): number;
} {
  let issueCallCount = 0;
  let allRequestCallCount = 0;
  const seerr = {
    async getUserById(id: number) {
      return {
        id,
        plexId: 10,
        plexUsername: "tyler",
        displayName: "Tyler",
        email: null,
        permissions: options.permissions,
      };
    },
    async getRequestsByUser() {
      if (options.rejectOwnRequests) {
        throw new Error("Seerr failed");
      }
      return options.ownRequests;
    },
    async listAllRequests() {
      allRequestCallCount += 1;
      return options.allRequests ?? [];
    },
    async listIssues() {
      issueCallCount += 1;
      return options.issues;
    },
  } as unknown as SeerrClient;

  const app = express();
  app.use(
    "/api/me",
    requireAuth(SECRET, seerr, { isRevoked: () => false }),
    createMeRouter({
      seerr,
      plexServer: {} as PlexServerClient,
      preferences: defaultPreferences,
      ...(options.accessRequests === undefined
        ? {}
        : { accessRequestStore: { list: () => options.accessRequests! } }),
    }),
  );

  return {
    app,
    issueCalls: () => issueCallCount,
    allRequestCalls: () => allRequestCallCount,
  };
}

function requestRow(
  status: number,
  mediaStatus: number,
  id: number,
): SeerrRequest {
  return {
    id,
    status,
    type: "movie",
    seasons: [],
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    requestedBy: {
      id: 44,
      displayName: "Tyler",
      plexUsername: "tyler",
    },
    media: {
      tmdbId: 600 + id,
      tvdbId: null,
      mediaType: "movie",
      status: mediaStatus,
      ratingKey: null,
    },
  };
}

function issueRow(
  createdById: number,
  status: IssueStatus,
  id: number,
): IssueView {
  return {
    id,
    issueType: "video",
    status,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    problemSeason: null,
    problemEpisode: null,
    media: {
      id: 100 + id,
      tmdbId: 600 + id,
      mediaType: "movie",
      title: null,
      posterUrl: null,
    },
    createdBy: {
      id: createdById,
      displayName: "Reporter",
      plexUsername: "reporter",
    },
    comments: [],
  };
}

function accessRequestRow(
  status: AccessRequestStatus,
  id: string,
): AccessRequest {
  return {
    id,
    email: `${id}@example.com`,
    plexUsername: null,
    name: id,
    note: "",
    hasPlexAccount: false,
    status,
    createdAt: 0,
    decidedAt: null,
    invitedAt: null,
    acceptedAt: null,
    sectionIds: null,
    adminNote: null,
    sourceIp: null,
  };
}

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

async function fetchMePreferences(
  app: express.Express,
  init: {
    cookie?: string | null;
    body?: unknown;
    omitContentType?: boolean;
  } = {},
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    const headers: Record<string, string> = {};
    if (init.cookie) {
      headers.Cookie = init.cookie;
    }
    if (!init.omitContentType) {
      headers["content-type"] = "application/json";
    }
    return await fetch(
      `http://127.0.0.1:${address.port}/api/me/preferences`,
      {
        method: "PATCH",
        headers,
        body:
          init.body === undefined ? undefined : JSON.stringify(init.body),
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function buildPreferencesApp(preferences: UserPreferencesStore): {
  app: express.Express;
  seerr: SeerrClient;
} {
  const seerr = {
    async getUserById(id: number) {
      return {
        id,
        plexId: 10,
        plexUsername: "tyler",
        displayName: "Tyler",
        email: null,
        permissions: 0,
      };
    },
  } as SeerrClient;

  const app = express();
  app.use(express.json());
  app.use(
    "/api/me",
    requireAuth(SECRET, seerr, { isRevoked: () => false }),
    createMeRouter({
      seerr,
      plexServer: {} as PlexServerClient,
      preferences,
    }),
  );
  return { app, seerr };
}

describe("PATCH /api/me/preferences", () => {
  it("returns 200 with the merged preferences and persists for the caller", async () => {
    let stored = { fullscreenOnPlay: true };
    const preferences: UserPreferencesStore = {
      get: () => stored,
      async set(_id, patch) {
        stored = { ...stored, ...patch };
        return stored;
      },
    };
    const { app } = buildPreferencesApp(preferences);

    const response = await fetchMePreferences(app, {
      cookie: sessionCookie(44),
      body: { fullscreenOnPlay: false },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { fullscreenOnPlay: false });
    assert.deepEqual(preferences.get(44), { fullscreenOnPlay: false });
  });

  it("returns 400 for a non-boolean fullscreenOnPlay and leaves the store unchanged", async () => {
    let setCalls = 0;
    const preferences: UserPreferencesStore = {
      get: () => ({ fullscreenOnPlay: true }),
      async set() {
        setCalls += 1;
        return { fullscreenOnPlay: true };
      },
    };
    const { app } = buildPreferencesApp(preferences);

    const response = await fetchMePreferences(app, {
      cookie: sessionCookie(44),
      body: { fullscreenOnPlay: "no" },
    });

    assert.equal(response.status, 400);
    assert.equal(setCalls, 0);
  });

  it("returns 400 for a missing body and leaves the store unchanged", async () => {
    let setCalls = 0;
    const preferences: UserPreferencesStore = {
      get: () => ({ fullscreenOnPlay: true }),
      async set() {
        setCalls += 1;
        return { fullscreenOnPlay: true };
      },
    };
    const { app } = buildPreferencesApp(preferences);

    const response = await fetchMePreferences(app, {
      cookie: sessionCookie(44),
      body: undefined,
      omitContentType: true,
    });

    assert.equal(response.status, 400);
    assert.equal(setCalls, 0);
  });

  it("returns 400 for a non-object body and leaves the store unchanged", async () => {
    let setCalls = 0;
    const preferences: UserPreferencesStore = {
      get: () => ({ fullscreenOnPlay: true }),
      async set() {
        setCalls += 1;
        return { fullscreenOnPlay: true };
      },
    };
    const { app } = buildPreferencesApp(preferences);

    const response = await fetchMePreferences(app, {
      cookie: sessionCookie(44),
      body: ["fullscreenOnPlay", false],
    });

    assert.equal(response.status, 400);
    assert.equal(setCalls, 0);
  });

  it("returns 400 for an unrecognised key and leaves the store unchanged", async () => {
    let setCalls = 0;
    const preferences: UserPreferencesStore = {
      get: () => ({ fullscreenOnPlay: true }),
      async set() {
        setCalls += 1;
        return { fullscreenOnPlay: true };
      },
    };
    const { app } = buildPreferencesApp(preferences);

    const response = await fetchMePreferences(app, {
      cookie: sessionCookie(44),
      body: { fullscreenOnPlay: false, theme: "dark" },
    });

    assert.equal(response.status, 400);
    assert.equal(setCalls, 0);
  });

  it("returns 401 without a session", async () => {
    const { app } = buildPreferencesApp(defaultPreferences);

    const response = await fetchMePreferences(app, {
      cookie: null,
      body: { fullscreenOnPlay: false },
    });

    assert.equal(response.status, 401);
  });

  it("returns 500 when the store write rejects and does not report success", async () => {
    const preferences: UserPreferencesStore = {
      get: () => ({ fullscreenOnPlay: true }),
      async set() {
        throw new Error("disk full");
      },
    };
    const { app } = buildPreferencesApp(preferences);

    const response = await fetchMePreferences(app, {
      cookie: sessionCookie(44),
      body: { fullscreenOnPlay: false },
    });

    assert.equal(response.status, 500);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.fullscreenOnPlay, undefined);
    assert.equal(
      typeof body.error === "string" && body.error.includes("disk full"),
      false,
    );
  });
});
