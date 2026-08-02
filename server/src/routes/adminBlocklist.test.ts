import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import {
  SeerrUpstreamError,
  type SeerrBlocklistItem,
} from "../seerr/client";
import { isAdmin, type SessionPayload } from "../session";
import {
  createAdminBlocklistRouter,
  type AdminBlocklistRouterDeps,
} from "./adminBlocklist";

const adminSession: SessionPayload = {
  seerrUserId: 1,
  plexId: 10,
  plexUsername: "tyler",
  displayName: "Tyler",
  avatar: null,
  permissions: 2,
  iat: 1,
  exp: 2,
};

const nonAdminSession: SessionPayload = {
  ...adminSession,
  seerrUserId: 7,
  permissions: 0,
};

type CallLog = string[];

function blocklistRow(
  overrides: Partial<SeerrBlocklistItem> = {},
): SeerrBlocklistItem {
  return {
    id: 1,
    tmdbId: 603,
    mediaType: "movie",
    title: "The Matrix",
    ...overrides,
  };
}

function createTrackingDeps(options: {
  calls: CallLog;
  listResult?: { results: SeerrBlocklistItem[]; total: number };
  listError?: Error;
  addError?: Error;
  removeResult?: { mediaRowDeleted: boolean };
  removeError?: Error;
  enrichTitle?: string;
  enrichError?: Error;
}): AdminBlocklistRouterDeps {
  return {
    seerr: {
      async listBlocklist(opts = {}) {
        options.calls.push(
          `listBlocklist:${opts.take ?? ""}:${opts.skip ?? ""}:${opts.search ?? ""}`,
        );
        if (options.listError) {
          throw options.listError;
        }
        return (
          options.listResult ?? {
            results: [blocklistRow()],
            total: 1,
          }
        );
      },
      async addToBlocklist(input) {
        options.calls.push(
          `addToBlocklist:${input.tmdbId}:${input.mediaType}:${input.userId}:${input.title ?? ""}`,
        );
        if (options.addError) {
          throw options.addError;
        }
      },
      async removeFromBlocklist(tmdbId, mediaType) {
        options.calls.push(`removeFromBlocklist:${mediaType}:${tmdbId}`);
        if (options.removeError) {
          throw options.removeError;
        }
        return options.removeResult ?? { mediaRowDeleted: true };
      },
    },
    mediaEnrichment: {
      async enrich(items) {
        options.calls.push(
          `enrich:${items.map((i) => `${i.mediaType}:${i.tmdbId}`).join(",")}`,
        );
        if (options.enrichError) {
          throw options.enrichError;
        }
        if (options.enrichTitle === undefined) {
          return new Map();
        }
        const item = items[0];
        return new Map([
          [
            `${item.mediaType}:${item.tmdbId}`,
            { title: options.enrichTitle, posterUrl: null },
          ],
        ]);
      },
    },
  };
}

describe("GET /api/admin/blocklist", () => {
  it("returns mapped rows with defaults take=25 and skip=0", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      listResult: {
        results: [blocklistRow(), blocklistRow({ id: 2, tmdbId: 1396, mediaType: "tv", title: "Breaking Bad" })],
        total: 2,
      },
    });

    const response = await fetchLocal(createApp(deps), "/api/admin/blocklist");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      results: [
        { id: 1, tmdbId: 603, mediaType: "movie", title: "The Matrix" },
        { id: 2, tmdbId: 1396, mediaType: "tv", title: "Breaking Bad" },
      ],
      total: 2,
      take: 25,
      skip: 0,
    });
    assert.deepEqual(calls, ["listBlocklist:25:0:"]);
  });

  it("forwards take, skip, and search", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      listResult: { results: [], total: 0 },
    });

    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/blocklist?take=10&skip=20&search=matrix",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      results: [],
      total: 0,
      take: 10,
      skip: 20,
    });
    assert.deepEqual(calls, ["listBlocklist:10:20:matrix"]);
  });

  it("returns 400 for take out of range and calls nothing upstream", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls });

    for (const take of ["0", "101", "1.5", "abc"]) {
      calls.length = 0;
      const response = await fetchLocal(
        createApp(deps),
        `/api/admin/blocklist?take=${take}`,
      );
      assert.equal(response.status, 400, `take=${take}`);
      assert.deepEqual(calls, []);
    }
  });

  it("returns 400 for skip out of range and calls nothing upstream", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls });

    for (const skip of ["-1", "1.5", "abc"]) {
      calls.length = 0;
      const response = await fetchLocal(
        createApp(deps),
        `/api/admin/blocklist?skip=${skip}`,
      );
      assert.equal(response.status, 400, `skip=${skip}`);
      assert.deepEqual(calls, []);
    }
  });

  it("forwards SeerrUpstreamError status from listBlocklist", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      listError: new SeerrUpstreamError("down", 503),
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(createApp(deps), "/api/admin/blocklist");
      assert.equal(response.status, 503);
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe("POST /api/admin/blocklist", () => {
  it("blocklists with session userId and looked-up title, returns 201", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls, enrichTitle: "The Matrix" });

    const response = await fetchLocal(createApp(deps), "/api/admin/blocklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tmdbId: 603, mediaType: "movie" }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      tmdbId: 603,
      mediaType: "movie",
      alreadyBlocklisted: false,
    });
    assert.deepEqual(calls, [
      "enrich:movie:603",
      "addToBlocklist:603:movie:1:The Matrix",
    ]);
  });

  it("uses the body title when provided and skips enrichment", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls });

    const response = await fetchLocal(createApp(deps), "/api/admin/blocklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tmdbId: 603,
        mediaType: "movie",
        title: "Provided Title",
      }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(calls, ["addToBlocklist:603:movie:1:Provided Title"]);
  });

  it("omits title and continues when enrichment fails", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      enrichError: new Error("TMDB down"),
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(
        createApp(deps),
        "/api/admin/blocklist",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tmdbId: 603, mediaType: "movie" }),
        },
      );
      assert.equal(response.status, 201);
      assert.ok(calls.includes("addToBlocklist:603:movie:1:"));
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("returns 200 alreadyBlocklisted true on Seerr 412", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      enrichTitle: "The Matrix",
      addError: new SeerrUpstreamError("Item already blocklisted", 412),
    });

    const response = await fetchLocal(createApp(deps), "/api/admin/blocklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tmdbId: 603, mediaType: "movie" }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tmdbId: 603,
      mediaType: "movie",
      alreadyBlocklisted: true,
    });
  });

  it("returns 400 for invalid body and calls nothing upstream", async () => {
    const cases = [
      { tmdbId: 0, mediaType: "movie" },
      { tmdbId: 603, mediaType: "person" },
      { tmdbId: "x", mediaType: "movie" },
      { mediaType: "movie" },
      { tmdbId: 603 },
    ];
    for (const body of cases) {
      const calls: CallLog = [];
      const deps = createTrackingDeps({ calls });
      const response = await fetchLocal(
        createApp(deps),
        "/api/admin/blocklist",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(calls, []);
    }
  });

  it("never reads userId from the body", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls, enrichTitle: "The Matrix" });

    const response = await fetchLocal(createApp(deps), "/api/admin/blocklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tmdbId: 603,
        mediaType: "movie",
        userId: 999,
      }),
    });

    assert.equal(response.status, 201);
    assert.ok(calls.includes("addToBlocklist:603:movie:1:The Matrix"));
    assert.equal(
      calls.some((c) => c.includes(":999:")),
      false,
    );
  });

  it("forwards non-412 SeerrUpstreamError status from addToBlocklist", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      enrichTitle: "The Matrix",
      addError: new SeerrUpstreamError("boom", 500),
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(
        createApp(deps),
        "/api/admin/blocklist",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tmdbId: 603, mediaType: "movie" }),
        },
      );
      assert.equal(response.status, 500);
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe("DELETE /api/admin/blocklist/:mediaType/:tmdbId", () => {
  it("removes a blocklist entry and surfaces cascade and auto-request warnings", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      removeResult: { mediaRowDeleted: true },
    });

    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/blocklist/movie/603",
      { method: "DELETE" },
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      tmdbId: number;
      mediaType: string;
      mediaRowDeleted: boolean;
      willBeAutoRequested: boolean;
      warnings: string[];
    };
    assert.deepEqual(
      {
        tmdbId: body.tmdbId,
        mediaType: body.mediaType,
        mediaRowDeleted: body.mediaRowDeleted,
        willBeAutoRequested: body.willBeAutoRequested,
      },
      {
        tmdbId: 603,
        mediaType: "movie",
        mediaRowDeleted: true,
        willBeAutoRequested: true,
      },
    );
    assert.ok(
      body.warnings.some((w) => /request history/i.test(w)),
      "warnings should mention request history cascade",
    );
    assert.ok(
      body.warnings.some((w) => /auto-request|watchlist/i.test(w)),
      "warnings should mention auto-request / watchlist re-download risk",
    );
    assert.deepEqual(calls, ["removeFromBlocklist:movie:603"]);
  });

  it("warns when mediaRowDeleted is false (partial Seerr cleanup)", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      removeResult: { mediaRowDeleted: false },
    });

    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/blocklist/tv/1396",
      { method: "DELETE" },
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      mediaRowDeleted: boolean;
      willBeAutoRequested: boolean;
      warnings: string[];
    };
    assert.equal(body.mediaRowDeleted, false);
    assert.equal(body.willBeAutoRequested, true);
    // Match the partial-cleanup wording specifically. "media row" alone also
    // appears in the cascade warning that is added on every removal, so a
    // looser regex passes even when this branch never runs.
    assert.ok(
      body.warnings.some((w) => /partial cleanup/i.test(w)),
      "warnings should flag the partial cleanup specifically",
    );
  });

  it("returns 400 for invalid params and calls nothing upstream", async () => {
    const cases = [
      "/api/admin/blocklist/person/603",
      "/api/admin/blocklist/movie/0",
      "/api/admin/blocklist/movie/6.5",
    ];
    for (const path of cases) {
      const calls: CallLog = [];
      const deps = createTrackingDeps({ calls });
      const response = await fetchLocal(createApp(deps), path, {
        method: "DELETE",
      });
      assert.equal(response.status, 400, path);
      assert.deepEqual(calls, []);
    }
  });

  it("forwards SeerrUpstreamError status from removeFromBlocklist", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      removeError: new SeerrUpstreamError("boom", 500),
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(
        createApp(deps),
        "/api/admin/blocklist/movie/603",
        { method: "DELETE" },
      );
      assert.equal(response.status, 500);
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe("admin blocklist router auth", () => {
  it("returns 401 with no session and calls nothing upstream", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls });
    const response = await fetchLocal(
      createApp(deps, null),
      "/api/admin/blocklist",
    );
    assert.equal(response.status, 401);
    assert.deepEqual(calls, []);
  });

  it("returns 403 from the router itself for a non-admin session with no mount gate", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls });
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.session = nonAdminSession;
      next();
    });
    app.use("/api/admin/blocklist", createAdminBlocklistRouter(deps));

    const response = await fetchLocal(app, "/api/admin/blocklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tmdbId: 603, mediaType: "movie" }),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden" });
    assert.deepEqual(calls, []);
  });
});

function createApp(
  deps: AdminBlocklistRouterDeps,
  session: SessionPayload | null = adminSession,
): express.Express {
  const app = express();
  app.use(express.json());
  // Stand-in for requireAdmin at the mount: 401 with no session, 403 without
  // the admin bit, otherwise publish the session like the real gate does.
  app.use("/api/admin/blocklist", (_req, res, next) => {
    if (session === null) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    if (!isAdmin(session.permissions)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.locals.session = session;
    next();
  });
  app.use("/api/admin/blocklist", createAdminBlocklistRouter(deps));
  return app;
}

async function fetchLocal(
  app: express.Express,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    return await fetch(`http://127.0.0.1:${address.port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
