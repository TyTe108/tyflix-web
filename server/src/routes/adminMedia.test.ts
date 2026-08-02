import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import {
  SeerrUpstreamError,
  type SeerrMediaListItem,
  type SeerrRequest,
} from "../seerr/client";
import { isAdmin, type SessionPayload } from "../session";
import {
  createAdminMediaRouter,
  type AdminMediaRouterDeps,
} from "./adminMedia";

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

function mediaRow(
  overrides: Partial<SeerrMediaListItem> = {},
): SeerrMediaListItem {
  return {
    id: 317,
    tmdbId: 603,
    mediaType: "movie",
    status: 5,
    ratingKey: "45678",
    tvdbId: null,
    externalServiceId: 12,
    seasons: [],
    ...overrides,
  };
}

function requestRow(
  overrides: Partial<SeerrRequest> & {
    media?: Partial<SeerrRequest["media"]>;
  } = {},
): SeerrRequest {
  const { media: mediaOverrides, ...rest } = overrides;
  return {
    id: 100,
    status: 2,
    type: "movie",
    seasons: [],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T01:00:00.000Z",
    requestedBy: {
      id: 7,
      displayName: "Alice",
      plexUsername: "alice",
    },
    media: {
      tmdbId: 603,
      tvdbId: null,
      mediaType: "movie",
      status: 5,
      ratingKey: null,
      ...mediaOverrides,
    },
    ...rest,
  };
}

type CallLog = string[];

function createTrackingDeps(options: {
  mediaRow?: SeerrMediaListItem | null;
  deleteMediaFileError?: Error;
  addToBlocklistError?: Error;
  deleteMediaError?: Error;
  enrichError?: Error;
  enrichTitle?: string;
  requests?: SeerrRequest[];
  declineErrors?: Map<number, Error>;
  calls: CallLog;
}): AdminMediaRouterDeps {
  const row =
    options.mediaRow === undefined ? mediaRow() : options.mediaRow;
  const declineErrors = options.declineErrors ?? new Map();

  return {
    seerr: {
      async deleteMediaFile(mediaId) {
        options.calls.push(`deleteMediaFile:${mediaId}`);
        if (options.deleteMediaFileError) {
          throw options.deleteMediaFileError;
        }
      },
      async deleteMedia(mediaId) {
        options.calls.push(`deleteMedia:${mediaId}`);
        if (options.deleteMediaError) {
          throw options.deleteMediaError;
        }
      },
      async addToBlocklist(input) {
        options.calls.push(
          `addToBlocklist:${input.tmdbId}:${input.mediaType}:${input.userId}:${input.title ?? ""}`,
        );
        if (options.addToBlocklistError) {
          throw options.addToBlocklistError;
        }
      },
      async listAllRequests() {
        options.calls.push("listAllRequests");
        return options.requests ?? [];
      },
      async declineRequest(id) {
        options.calls.push(`declineRequest:${id}`);
        const err = declineErrors.get(id);
        if (err) {
          throw err;
        }
        return requestRow({ id });
      },
    },
    mediaStatus: {
      async getMediaRow(mediaType, tmdbId) {
        options.calls.push(`getMediaRow:${mediaType}:${tmdbId}`);
        if (row === null) {
          return null;
        }
        if (row.mediaType === mediaType && row.tmdbId === tmdbId) {
          return row;
        }
        return null;
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
        const title = options.enrichTitle;
        if (title === undefined) {
          return new Map();
        }
        const item = items[0];
        return new Map([
          [`${item.mediaType}:${item.tmdbId}`, { title, posterUrl: null }],
        ]);
      },
    },
  };
}

describe("DELETE /api/admin/media/:mediaType/:tmdbId", () => {
  it("returns 401 with no session and calls nothing upstream", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls });
    const response = await fetchLocal(
      createApp(deps, null),
      "/api/admin/media/movie/603",
      { method: "DELETE" },
    );

    assert.equal(response.status, 401);
    assert.deepEqual(calls, []);
  });

  it("returns 403 for a non-admin session and calls nothing upstream", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls });
    const response = await fetchLocal(
      createApp(deps, nonAdminSession),
      "/api/admin/media/movie/603",
      { method: "DELETE" },
    );

    assert.equal(response.status, 403);
    assert.deepEqual(calls, []);
  });

  it("returns 400 for an invalid mediaType and calls nothing upstream", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls });
    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/media/person/603",
      { method: "DELETE" },
    );

    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
  });

  it("returns 400 for a non-positive tmdbId and calls nothing upstream", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls });
    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/media/movie/0",
      { method: "DELETE" },
    );

    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
  });

  it("returns 400 for a non-integer tmdbId and calls nothing upstream", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls });
    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/media/movie/6.5",
      { method: "DELETE" },
    );

    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
  });

  it("returns 400 for an invalid blocklist query value and calls nothing upstream", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls });
    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/media/movie/603?blocklist=maybe",
      { method: "DELETE" },
    );

    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
  });

  it("returns 404 when Seerr is not tracking the title and deletes nothing", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ mediaRow: null, calls });
    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/media/movie/603",
      { method: "DELETE" },
    );

    assert.equal(response.status, 404);
    assert.deepEqual(calls, ["getMediaRow:movie:603"]);
  });

  it("deletes files, blocklists, and declines open requests in order", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      enrichTitle: "The Matrix",
      requests: [
        requestRow({ id: 10, status: 1 }),
        requestRow({ id: 11, status: 2 }),
        requestRow({ id: 12, status: 5 }), // completed, leave alone
        requestRow({
          id: 13,
          status: 2,
          type: "tv",
          media: {
            tmdbId: 1396,
            tvdbId: null,
            mediaType: "tv",
            status: 5,
            ratingKey: null,
          },
        }),
      ],
    });

    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/media/movie/603",
      { method: "DELETE" },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tmdbId: 603,
      mediaType: "movie",
      filesDeleted: true,
      blocklisted: true,
      mediaRowDeleted: null,
      requestsDeclined: [10, 11],
      requestsFailedToDecline: [],
    });
    assert.deepEqual(calls, [
      "getMediaRow:movie:603",
      "deleteMediaFile:317",
      "enrich:movie:603",
      "addToBlocklist:603:movie:1:The Matrix",
      "listAllRequests",
      "declineRequest:10",
      "declineRequest:11",
    ]);
  });

  it("treats blocklist=true the same as the default", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls, enrichTitle: "The Matrix" });
    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/media/movie/603?blocklist=true",
      { method: "DELETE" },
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as { blocklisted: unknown };
    assert.equal(body.blocklisted, true);
    assert.ok(calls.some((c) => c.startsWith("addToBlocklist:")));
    assert.equal(calls.some((c) => c.startsWith("deleteMedia:")), false);
  });

  it("uses deleteMedia when blocklist=false", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls });
    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/media/movie/603?blocklist=false",
      { method: "DELETE" },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tmdbId: 603,
      mediaType: "movie",
      filesDeleted: true,
      blocklisted: null,
      mediaRowDeleted: true,
      requestsDeclined: [],
      requestsFailedToDecline: [],
    });
    assert.deepEqual(calls, [
      "getMediaRow:movie:603",
      "deleteMediaFile:317",
      "deleteMedia:317",
      "listAllRequests",
    ]);
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
        "/api/admin/media/movie/603",
        { method: "DELETE" },
      );
      assert.equal(response.status, 200);
      assert.ok(
        calls.includes("addToBlocklist:603:movie:1:"),
        "blocklist call should omit title",
      );
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("forwards deleteMediaFile upstream status and skips later steps", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      deleteMediaFileError: new SeerrUpstreamError("hung", 504),
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(
        createApp(deps),
        "/api/admin/media/movie/603",
        { method: "DELETE" },
      );
      assert.equal(response.status, 504);
      assert.deepEqual(calls, [
        "getMediaRow:movie:603",
        "deleteMediaFile:317",
      ]);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("returns 500 with filesDeleted true when blocklist fails after file delete", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      enrichTitle: "The Matrix",
      addToBlocklistError: new SeerrUpstreamError("Seerr boom", 500),
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(
        createApp(deps),
        "/api/admin/media/movie/603",
        { method: "DELETE" },
      );
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        tmdbId: 603,
        mediaType: "movie",
        filesDeleted: true,
        blocklisted: false,
        mediaRowDeleted: null,
        requestsDeclined: [],
        requestsFailedToDecline: [],
        error: "Seerr boom",
      });
      assert.deepEqual(calls, [
        "getMediaRow:movie:603",
        "deleteMediaFile:317",
        "enrich:movie:603",
        "addToBlocklist:603:movie:1:The Matrix",
      ]);
      assert.equal(calls.includes("listAllRequests"), false);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("treats addToBlocklist 412 as success (already blocklisted)", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      enrichTitle: "The Matrix",
      addToBlocklistError: new SeerrUpstreamError(
        "Item already blocklisted",
        412,
      ),
    });

    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/media/movie/603",
      { method: "DELETE" },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tmdbId: 603,
      mediaType: "movie",
      filesDeleted: true,
      blocklisted: true,
      mediaRowDeleted: null,
      requestsDeclined: [],
      requestsFailedToDecline: [],
    });
  });

  it("returns 500 with mediaRowDeleted false when deleteMedia fails after file delete", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      deleteMediaError: new SeerrUpstreamError("row delete failed", 500),
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(
        createApp(deps),
        "/api/admin/media/movie/603?blocklist=false",
        { method: "DELETE" },
      );
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        tmdbId: 603,
        mediaType: "movie",
        filesDeleted: true,
        blocklisted: null,
        mediaRowDeleted: false,
        requestsDeclined: [],
        requestsFailedToDecline: [],
        error: "row delete failed",
      });
      assert.equal(calls.includes("listAllRequests"), false);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("keeps 200 when a decline fails and records requestsFailedToDecline", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      enrichTitle: "The Matrix",
      requests: [
        requestRow({ id: 10, status: 2 }),
        requestRow({ id: 11, status: 1 }),
      ],
      declineErrors: new Map([
        [11, new SeerrUpstreamError("decline failed", 500)],
      ]),
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(
        createApp(deps),
        "/api/admin/media/movie/603",
        { method: "DELETE" },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        tmdbId: 603,
        mediaType: "movie",
        filesDeleted: true,
        blocklisted: true,
        mediaRowDeleted: null,
        requestsDeclined: [10],
        requestsFailedToDecline: [11],
      });
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("returns 403 from the router itself for a non-admin session with no mount gate", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({ calls });
    // No createApp stand-in: inject a non-admin session and mount the router
    // alone so this exercises the handler's own isAdmin check.
    const app = express();
    app.use((_req, res, next) => {
      res.locals.session = nonAdminSession;
      next();
    });
    app.use("/api/admin/media", createAdminMediaRouter(deps));

    const response = await fetchLocal(app, "/api/admin/media/movie/603", {
      method: "DELETE",
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden" });
    assert.deepEqual(calls, []);
  });

  it("does not decline a TV request with the same tmdbId when removing a movie", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      enrichTitle: "The Matrix",
      requests: [
        requestRow({
          id: 10,
          status: 2,
          type: "movie",
          media: {
            tmdbId: 603,
            tvdbId: null,
            mediaType: "movie",
            status: 5,
            ratingKey: null,
          },
        }),
        requestRow({
          id: 20,
          status: 2,
          type: "tv",
          media: {
            tmdbId: 603,
            tvdbId: null,
            mediaType: "tv",
            status: 5,
            ratingKey: null,
          },
        }),
      ],
    });

    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/media/movie/603",
      { method: "DELETE" },
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      requestsDeclined: number[];
      requestsFailedToDecline: number[];
    };
    assert.deepEqual(body.requestsDeclined, [10]);
    assert.deepEqual(body.requestsFailedToDecline, []);
    assert.equal(calls.includes("declineRequest:20"), false);
  });
});

function createApp(
  deps: AdminMediaRouterDeps,
  session: SessionPayload | null = adminSession,
): express.Express {
  const app = express();
  // Stand-in for requireAdmin at the mount: 401 with no session, 403 without
  // the admin bit, otherwise publish the session like the real gate does.
  app.use("/api/admin/media", (req, res, next) => {
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
  app.use("/api/admin/media", createAdminMediaRouter(deps));
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
