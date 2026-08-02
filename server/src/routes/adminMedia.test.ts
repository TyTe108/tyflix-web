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
  SonarrUpstreamError,
  type SonarrEpisode,
  type SonarrEpisodeFile,
  type SonarrSeries,
} from "../sonarr/client";
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
  overrides: Omit<Partial<SeerrRequest>, "media"> & {
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
  series?: SonarrSeries;
  episodes?: SonarrEpisode[];
  episodeFiles?: SonarrEpisodeFile[];
  setSeasonsMonitoredError?: Error;
  setEpisodesMonitoredError?: Error;
  deleteEpisodeFileErrors?: Map<number, Error>;
  calls: CallLog;
}): AdminMediaRouterDeps {
  const row =
    options.mediaRow === undefined ? mediaRow() : options.mediaRow;
  const declineErrors = options.declineErrors ?? new Map();
  const deleteEpisodeFileErrors = options.deleteEpisodeFileErrors ?? new Map();

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
    sonarr: {
      async getSeries(seriesId) {
        options.calls.push(`getSeries:${seriesId}`);
        return (
          options.series ?? {
            id: seriesId,
            seasons: [
              { seasonNumber: 0, monitored: false },
              { seasonNumber: 1, monitored: true },
            ],
          }
        );
      },
      async listEpisodes(seriesId) {
        options.calls.push(`listEpisodes:${seriesId}`);
        return options.episodes ?? [];
      },
      async listEpisodeFiles(seriesId) {
        options.calls.push(`listEpisodeFiles:${seriesId}`);
        return options.episodeFiles ?? [];
      },
      async setSeasonsMonitored(seriesId, seasonNumbers, monitored) {
        options.calls.push(
          `setSeasonsMonitored:${seriesId}:${seasonNumbers.join(",")}:${monitored}`,
        );
        if (options.setSeasonsMonitoredError) {
          throw options.setSeasonsMonitoredError;
        }
      },
      async setEpisodesMonitored(episodeIds, monitored) {
        options.calls.push(
          `setEpisodesMonitored:${episodeIds.join(",")}:${monitored}`,
        );
        if (options.setEpisodesMonitoredError) {
          throw options.setEpisodesMonitoredError;
        }
      },
      async deleteEpisodeFile(fileId) {
        options.calls.push(`deleteEpisodeFile:${fileId}`);
        const err = deleteEpisodeFileErrors.get(fileId);
        if (err) {
          throw err;
        }
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

describe("GET /api/admin/media/tv/:tmdbId/seasons", () => {
  it("returns season 0 and joins episode file sizes", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      mediaRow: mediaRow({
        tmdbId: 1396,
        mediaType: "tv",
        externalServiceId: 97,
      }),
      series: {
        id: 97,
        seasons: [
          { seasonNumber: 0, monitored: false },
          { seasonNumber: 1, monitored: true },
        ],
      },
      episodes: [
        {
          id: 100,
          seasonNumber: 0,
          episodeNumber: 1,
          title: "Special",
          episodeFileId: 500,
          hasFile: true,
          monitored: false,
        },
        {
          id: 101,
          seasonNumber: 1,
          episodeNumber: 1,
          title: "Pilot",
          episodeFileId: 501,
          hasFile: true,
          monitored: true,
        },
        {
          id: 102,
          seasonNumber: 1,
          episodeNumber: 2,
          title: "Missing",
          episodeFileId: 0,
          hasFile: false,
          monitored: true,
        },
      ],
      episodeFiles: [
        {
          id: 500,
          seasonNumber: 0,
          path: "/tv/show/S00E01.mkv",
          size: 50,
        },
        {
          id: 501,
          seasonNumber: 1,
          path: "/tv/show/S01E01.mkv",
          size: 100,
        },
      ],
    });

    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/media/tv/1396/seasons",
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tmdbId: 1396,
      sonarrSeriesId: 97,
      seasons: [
        {
          seasonNumber: 0,
          monitored: false,
          episodeCount: 1,
          episodeFileCount: 1,
          sizeOnDisk: 50,
          episodes: [
            {
              id: 100,
              episodeNumber: 1,
              title: "Special",
              monitored: false,
              hasFile: true,
              episodeFileId: 500,
              size: 50,
            },
          ],
        },
        {
          seasonNumber: 1,
          monitored: true,
          episodeCount: 2,
          episodeFileCount: 1,
          sizeOnDisk: 100,
          episodes: [
            {
              id: 101,
              episodeNumber: 1,
              title: "Pilot",
              monitored: true,
              hasFile: true,
              episodeFileId: 501,
              size: 100,
            },
            {
              id: 102,
              episodeNumber: 2,
              title: "Missing",
              monitored: true,
              hasFile: false,
              episodeFileId: 0,
              size: 0,
            },
          ],
        },
      ],
    });
    assert.deepEqual(calls, [
      "getMediaRow:tv:1396",
      "getSeries:97",
      "listEpisodes:97",
      "listEpisodeFiles:97",
    ]);
  });

  it("returns 400 for an invalid tmdbId and calls nothing upstream", async () => {
    const calls: CallLog = [];
    const response = await fetchLocal(
      createApp(createTrackingDeps({ calls })),
      "/api/admin/media/tv/0/seasons",
    );

    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
  });

  it("returns 404 when Seerr is not tracking the title", async () => {
    const calls: CallLog = [];
    const response = await fetchLocal(
      createApp(createTrackingDeps({ calls, mediaRow: null })),
      "/api/admin/media/tv/1396/seasons",
    );

    assert.equal(response.status, 404);
    assert.deepEqual(calls, ["getMediaRow:tv:1396"]);
  });

  it("returns 409 when Seerr has no Sonarr series id", async () => {
    const calls: CallLog = [];
    const response = await fetchLocal(
      createApp(
        createTrackingDeps({
          calls,
          mediaRow: mediaRow({
            tmdbId: 1396,
            mediaType: "tv",
            externalServiceId: null,
          }),
        }),
      ),
      "/api/admin/media/tv/1396/seasons",
    );

    assert.equal(response.status, 409);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /Sonarr series id/i,
    );
    assert.deepEqual(calls, ["getMediaRow:tv:1396"]);
  });
});

describe("DELETE /api/admin/media/tv/:tmdbId/season/:seasonNumber", () => {
  it("unmonitors before deleting files and declines only fully covered requests", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      mediaRow: mediaRow({
        tmdbId: 1396,
        mediaType: "tv",
        externalServiceId: 97,
      }),
      episodeFiles: [
        {
          id: 501,
          seasonNumber: 3,
          path: "/tv/show/S03E01.mkv",
          size: 100,
        },
        {
          id: 502,
          seasonNumber: 3,
          path: "/tv/show/S03E02.mkv",
          size: 200,
        },
        {
          id: 601,
          seasonNumber: 4,
          path: "/tv/show/S04E01.mkv",
          size: 300,
        },
      ],
      requests: [
        requestRow({
          id: 10,
          status: 2,
          type: "tv",
          seasons: [{ seasonNumber: 3 }],
          media: { tmdbId: 1396, mediaType: "tv" },
        }),
        requestRow({
          id: 11,
          status: 1,
          type: "tv",
          seasons: [
            { seasonNumber: 1 },
            { seasonNumber: 2 },
            { seasonNumber: 3 },
            { seasonNumber: 4 },
          ],
          media: { tmdbId: 1396, mediaType: "tv" },
        }),
      ],
    });

    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/media/tv/1396/season/3",
      { method: "DELETE" },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tmdbId: 1396,
      seasonNumber: 3,
      unmonitored: true,
      filesDeleted: [501, 502],
      filesFailedToDelete: [],
      requestsDeclined: [10],
      requestsLeftOpen: [{ id: 11, seasons: [1, 2, 3, 4] }],
    });
    assert.deepEqual(calls, [
      "getMediaRow:tv:1396",
      "listEpisodeFiles:97",
      "setSeasonsMonitored:97:3:false",
      "deleteEpisodeFile:501",
      "deleteEpisodeFile:502",
      "listAllRequests",
      "declineRequest:10",
    ]);
  });

  it("accepts season 0 with no files as successful meaningful work", async () => {
    const calls: CallLog = [];
    const response = await fetchLocal(
      createApp(
        createTrackingDeps({
          calls,
          mediaRow: mediaRow({
            tmdbId: 1396,
            mediaType: "tv",
            externalServiceId: 97,
          }),
          episodeFiles: [],
        }),
      ),
      "/api/admin/media/tv/1396/season/0",
      { method: "DELETE" },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tmdbId: 1396,
      seasonNumber: 0,
      unmonitored: true,
      filesDeleted: [],
      filesFailedToDelete: [],
      requestsDeclined: [],
      requestsLeftOpen: [],
    });
    assert.deepEqual(calls, [
      "getMediaRow:tv:1396",
      "listEpisodeFiles:97",
      "setSeasonsMonitored:97:0:false",
      "listAllRequests",
    ]);
  });

  it("returns 400 for a negative or non-integer season and calls nothing upstream", async () => {
    for (const season of ["-1", "1.5"]) {
      const calls: CallLog = [];
      const response = await fetchLocal(
        createApp(createTrackingDeps({ calls })),
        `/api/admin/media/tv/1396/season/${season}`,
        { method: "DELETE" },
      );
      assert.equal(response.status, 400, season);
      assert.deepEqual(calls, []);
    }
  });

  it("aborts without deleting files when unmonitoring fails", async () => {
    const calls: CallLog = [];
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(
        createApp(
          createTrackingDeps({
            calls,
            mediaRow: mediaRow({
              tmdbId: 1396,
              mediaType: "tv",
              externalServiceId: 97,
            }),
            episodeFiles: [
              {
                id: 501,
                seasonNumber: 3,
                path: "/tv/show/S03E01.mkv",
                size: 100,
              },
            ],
            setSeasonsMonitoredError: new SonarrUpstreamError("down", 503),
          }),
        ),
        "/api/admin/media/tv/1396/season/3",
        { method: "DELETE" },
      );

      assert.equal(response.status, 503);
      assert.deepEqual(calls, [
        "getMediaRow:tv:1396",
        "listEpisodeFiles:97",
        "setSeasonsMonitored:97:3:false",
      ]);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("returns 500 with per-file results on a partial delete", async () => {
    const calls: CallLog = [];
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(
        createApp(
          createTrackingDeps({
            calls,
            mediaRow: mediaRow({
              tmdbId: 1396,
              mediaType: "tv",
              externalServiceId: 97,
            }),
            episodeFiles: [
              {
                id: 501,
                seasonNumber: 3,
                path: "/tv/show/S03E01.mkv",
                size: 100,
              },
              {
                id: 502,
                seasonNumber: 3,
                path: "/tv/show/S03E02.mkv",
                size: 200,
              },
            ],
            deleteEpisodeFileErrors: new Map([
              [502, new SonarrUpstreamError("stale file", 404)],
            ]),
          }),
        ),
        "/api/admin/media/tv/1396/season/3",
        { method: "DELETE" },
      );

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        tmdbId: 1396,
        seasonNumber: 3,
        unmonitored: true,
        filesDeleted: [501],
        filesFailedToDelete: [{ fileId: 502, error: "stale file" }],
        requestsDeclined: [],
        requestsLeftOpen: [],
      });
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe("DELETE /api/admin/media/tv/:tmdbId/episode/:episodeId", () => {
  it("unmonitors one episode, deletes its file, and leaves requests open", async () => {
    const calls: CallLog = [];
    const deps = createTrackingDeps({
      calls,
      mediaRow: mediaRow({
        tmdbId: 1396,
        mediaType: "tv",
        externalServiceId: 97,
      }),
      episodes: [
        {
          id: 101,
          seasonNumber: 3,
          episodeNumber: 1,
          title: "Episode",
          episodeFileId: 501,
          hasFile: true,
          monitored: true,
        },
      ],
      requests: [
        requestRow({
          id: 11,
          status: 2,
          type: "tv",
          seasons: [{ seasonNumber: 3 }],
          media: { tmdbId: 1396, mediaType: "tv" },
        }),
      ],
    });

    const response = await fetchLocal(
      createApp(deps),
      "/api/admin/media/tv/1396/episode/101",
      { method: "DELETE" },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tmdbId: 1396,
      episodeId: 101,
      seasonNumber: 3,
      unmonitored: true,
      fileDeleted: true,
      fileId: 501,
      requestsLeftOpen: [{ id: 11, seasons: [3] }],
    });
    assert.deepEqual(calls, [
      "getMediaRow:tv:1396",
      "listEpisodes:97",
      "setEpisodesMonitored:101:false",
      "deleteEpisodeFile:501",
      "listAllRequests",
    ]);
  });

  it("succeeds without deleting a file when hasFile is false", async () => {
    const calls: CallLog = [];
    const response = await fetchLocal(
      createApp(
        createTrackingDeps({
          calls,
          mediaRow: mediaRow({
            tmdbId: 1396,
            mediaType: "tv",
            externalServiceId: 97,
          }),
          episodes: [
            {
              id: 102,
              seasonNumber: 3,
              episodeNumber: 2,
              title: "Missing",
              episodeFileId: 0,
              hasFile: false,
              monitored: true,
            },
          ],
        }),
      ),
      "/api/admin/media/tv/1396/episode/102",
      { method: "DELETE" },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tmdbId: 1396,
      episodeId: 102,
      seasonNumber: 3,
      unmonitored: true,
      fileDeleted: false,
      fileId: null,
      requestsLeftOpen: [],
    });
    assert.equal(calls.some((call) => call.startsWith("deleteEpisodeFile:")), false);
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
