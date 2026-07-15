import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  SeerrUpstreamError,
  createSeerrClient,
  mediaStatusFromCode,
  toRequestView,
  type SeerrRequest,
} from "./client";
import {
  issueStatusFromCode,
  issueTypeFromCode,
  issueTypeToCode,
  mapSeerrIssue,
} from "./issues";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function userRow(overrides: Partial<{
  id: number;
  plexId: number;
  plexUsername: string;
  displayName: string;
  email: string | null;
  permissions: number;
}> = {}) {
  return {
    id: 1,
    plexId: 100,
    plexUsername: "alice",
    displayName: "Alice",
    email: "a@example.com",
    permissions: 0,
    ...overrides,
  };
}

function requestRow(
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
      displayName: "Alice",
      plexUsername: "alice",
    },
    media: {
      tmdbId: 603,
      tvdbId: null,
      mediaType: "movie",
      status: 1,
      ratingKey: null,
    },
    ...overrides,
  };
}

function issueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 51,
    issueType: 1,
    status: 1,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T01:00:00.000Z",
    problemSeason: null,
    problemEpisode: null,
    media: {
      id: 10,
      tmdbId: 603,
      mediaType: "movie",
    },
    createdBy: {
      id: 7,
      displayName: "Alice",
      plexUsername: "alice",
    },
    comments: [
      {
        id: 91,
        message: "Playback stutters",
        createdAt: "2026-07-15T00:05:00.000Z",
        user: { id: 7, displayName: "Alice" },
      },
    ],
    ...overrides,
  };
}

describe("createSeerrClient().getUserByPlexId", () => {
  it("requests with X-Api-Key and returns the matching user", async () => {
    const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({
        url: String(input),
        headers: init?.headers,
      });
      return jsonResponse(200, {
        pageInfo: { results: 1 },
        results: [userRow({ id: 9, plexId: 42, permissions: 2 })],
      });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "secret-key",
    });
    const user = await seerr.getUserByPlexId(42);

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "http://seerr:5055/api/v1/user?take=100&skip=0",
    );
    const headers = new Headers(calls[0].headers);
    assert.equal(headers.get("X-Api-Key"), "secret-key");
    assert.equal(headers.get("Accept"), "application/json");
    assert.deepEqual(user, {
      id: 9,
      plexId: 42,
      plexUsername: "alice",
      displayName: "Alice",
      email: "a@example.com",
      permissions: 2,
    });
  });

  it("paginates with skip increments of 100 until the match is found", async () => {
    const skips: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      skips.push(url.searchParams.get("skip") ?? "");
      const skip = Number(url.searchParams.get("skip"));
      if (skip === 0) {
        return jsonResponse(200, {
          pageInfo: { results: 101 },
          results: Array.from({ length: 100 }, (_, i) =>
            userRow({ id: i + 1, plexId: 1000 + i }),
          ),
        });
      }
      return jsonResponse(200, {
        pageInfo: { results: 101 },
        results: [userRow({ id: 101, plexId: 777, displayName: "Found" })],
      });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    const user = await seerr.getUserByPlexId(777);

    assert.deepEqual(skips, ["0", "100"]);
    assert.equal(user?.plexId, 777);
    assert.equal(user?.displayName, "Found");
  });

  it("returns null when no user matches the plexId", async () => {
    globalThis.fetch = async () =>
      jsonResponse(200, {
        pageInfo: { results: 1 },
        results: [userRow({ plexId: 1 })],
      });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    assert.equal(await seerr.getUserByPlexId(999), null);
  });

  it("throws SeerrUpstreamError on a non-2xx response", async () => {
    globalThis.fetch = async () => jsonResponse(503, { message: "down" });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () => seerr.getUserByPlexId(1),
      (err: unknown) =>
        err instanceof SeerrUpstreamError &&
        err.status === 503 &&
        err.message.includes("503"),
    );
  });

  it("throws SeerrUpstreamError when fetch itself fails", async () => {
    globalThis.fetch = async () => {
      throw new Error("network down");
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () => seerr.getUserByPlexId(1),
      (err: unknown) =>
        err instanceof SeerrUpstreamError &&
        err.message.includes("network down"),
    );
  });
});

describe("Seerr media client", () => {
  it("paginates media, maps valid rows, and skips malformed rows", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url.search);
      if (url.searchParams.get("skip") === "0") {
        return jsonResponse(200, {
          pageInfo: { results: 101 },
          results: [
            { id: 10, tmdbId: 603, mediaType: "movie", status: 5, tvdbId: null },
            { id: 11, tmdbId: "bad", mediaType: "movie", status: 2 },
            { id: 12, tmdbId: 1, mediaType: "tv" },
            { id: 13, tmdbId: 2, mediaType: "person", status: 5 },
          ],
        });
      }
      return jsonResponse(200, {
        pageInfo: { results: 101 },
        results: [{ id: 20, tmdbId: 1396, mediaType: "tv", status: 4 }],
      });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    assert.deepEqual(await seerr.listMedia(), [
      { id: 10, tmdbId: 603, mediaType: "movie", status: 5 },
      { id: 20, tmdbId: 1396, mediaType: "tv", status: 4 },
    ]);
    assert.deepEqual(calls, ["?take=100&skip=0", "?take=100&skip=100"]);
  });

  it("maps all known media status codes and returns null for unknown codes", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 0, 8].map(mediaStatusFromCode),
      [
        "unknown",
        "pending",
        "processing",
        "partially_available",
        "available",
        "blocklisted",
        "deleted",
        null,
        null,
      ],
    );
  });
});

describe("Seerr watchlist client", () => {
  it("maps valid rows, skips malformed rows, and paginates", async () => {
    const pages: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      pages.push(url.searchParams.get("page") ?? "");
      if (url.searchParams.get("page") === "1") {
        return jsonResponse(200, {
          page: 1,
          totalPages: 2,
          totalResults: 4,
          results: [
            {
              id: 1,
              ratingKey: "10",
              title: "The Matrix",
              mediaType: "movie",
              tmdbId: 603,
            },
            {
              id: 2,
              ratingKey: "11",
              title: "Missing TMDB id",
              mediaType: "movie",
            },
            {
              id: 3,
              title: "Wrong media type",
              mediaType: "person",
              tmdbId: 12,
            },
          ],
        });
      }
      return jsonResponse(200, {
        page: 2,
        totalPages: 2,
        totalResults: 4,
        results: [
          {
            id: 4,
            ratingKey: "12",
            title: "Breaking Bad",
            mediaType: "tv",
            tmdbId: 1396,
          },
        ],
      });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    assert.deepEqual(await seerr.listUserWatchlist(7), [
      { tmdbId: 603, mediaType: "movie", title: "The Matrix" },
      { tmdbId: 1396, mediaType: "tv", title: "Breaking Bad" },
    ]);
    assert.deepEqual(pages, ["1", "2"]);
  });
});

describe("Seerr issues client", () => {
  it("maps issue type and status codes", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5].map(issueTypeFromCode),
      ["video", "audio", "subtitles", "other", null],
    );
    assert.deepEqual(
      ["video", "audio", "subtitles", "other"].map((type) =>
        issueTypeToCode(type as "video" | "audio" | "subtitles" | "other"),
      ),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      [1, 2, 3].map(issueStatusFromCode),
      ["open", "resolved", null],
    );
    assert.equal(mapSeerrIssue(issueRow())?.comments[0].message, "Playback stutters");
  });

  it("paginates issues, maps valid rows, and skips malformed rows", async () => {
    const urls: URL[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.searchParams.get("skip") === "0") {
        return jsonResponse(200, {
          pageInfo: { results: 101 },
          results: [issueRow(), issueRow({ id: 52, issueType: 99 })],
        });
      }
      return jsonResponse(200, {
        pageInfo: { results: 101 },
        results: [issueRow({ id: 53, status: 2, comments: undefined })],
      });
    };
    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    const issues = await seerr.listIssues();

    assert.deepEqual(issues.map((issue) => issue.id), [51, 53]);
    assert.equal(issues[1].status, "resolved");
    assert.deepEqual(
      urls.map((url) => url.searchParams.get("skip")),
      ["0", "100"],
    );
    for (const url of urls) {
      assert.equal(url.searchParams.get("sort"), "added");
      assert.equal(url.searchParams.has("createdBy"), false);
      assert.equal(url.searchParams.get("filter"), "all");
    }
  });

  it("requests all statuses and returns resolved issues", async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("filter"), "all");
      return jsonResponse(200, {
        pageInfo: { results: 1 },
        results: [issueRow({ id: 54, status: 2 })],
      });
    };
    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    const issues = await seerr.listIssues();

    assert.equal(issues.length, 1);
    assert.equal(issues[0].id, 54);
    assert.equal(issues[0].status, "resolved");
  });

  it("creates an issue with numeric type, userId, and problem location", async () => {
    let call:
      | { url: string; method: string | undefined; body: string | undefined }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = {
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      return jsonResponse(201, issueRow({ issueType: 3 }));
    };
    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await seerr.createIssue({
      issueType: "subtitles",
      message: "Subtitle timing is wrong",
      mediaId: 10,
      userId: 44,
      problemSeason: 2,
      problemEpisode: 3,
    });

    assert.ok(call);
    assert.equal(call.url, "http://seerr:5055/api/v1/issue");
    assert.equal(call.method, "POST");
    assert.deepEqual(JSON.parse(call.body ?? ""), {
      issueType: 3,
      message: "Subtitle timing is wrong",
      mediaId: 10,
      userId: 44,
      problemSeason: 2,
      problemEpisode: 3,
    });
  });
});

describe("Seerr requests client", () => {
  it("maps every request and media status to its label", () => {
    const requestStatuses = [
      "pending",
      "approved",
      "declined",
      "failed",
      "completed",
    ];
    const mediaStatuses = [
      "unknown",
      "pending",
      "processing",
      "partially_available",
      "available",
      "blocklisted",
      "deleted",
    ];

    for (let status = 1; status <= requestStatuses.length; status += 1) {
      const view = toRequestView(requestRow({ status }), "The Matrix");
      assert.equal(view.requestStatus, requestStatuses[status - 1]);
    }
    for (let status = 1; status <= mediaStatuses.length; status += 1) {
      const request = requestRow({
        media: { ...requestRow().media, status },
      });
      const view = toRequestView(request, "The Matrix");
      assert.equal(view.mediaStatus, mediaStatuses[status - 1]);
    }
  });

  it("creates a TV request with mediaId, userId, and seasons", async () => {
    let call:
      | { url: string; method: string | undefined; body: string | undefined }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = {
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      return jsonResponse(
        201,
        requestRow({
          type: "tv",
          seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
          media: {
            ...requestRow().media,
            tmdbId: 1396,
            mediaType: "tv",
          },
        }),
      );
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    await seerr.createRequest({
      mediaType: "tv",
      tmdbId: 1396,
      seasons: [1, 2],
      userId: 7,
    });

    assert.ok(call);
    assert.equal(call.url, "http://seerr:5055/api/v1/request");
    assert.equal(call.method, "POST");
    assert.deepEqual(JSON.parse(call.body ?? ""), {
      mediaType: "tv",
      mediaId: 1396,
      seasons: [1, 2],
      userId: 7,
    });
  });

  it("lists requests from the per-user endpoint", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return jsonResponse(200, {
        pageInfo: { results: 1 },
        results: [requestRow()],
      });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    const requests = await seerr.listUserRequests(7);

    assert.equal(requests.length, 1);
    assert.equal(
      urls[0],
      "http://seerr:5055/api/v1/user/7/requests?take=100&skip=0",
    );
  });

  it("throws SeerrUpstreamError for request API failures", async () => {
    globalThis.fetch = async () =>
      jsonResponse(503, { message: "unavailable" });
    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () => seerr.listAllRequests(),
      (err: unknown) =>
        err instanceof SeerrUpstreamError && err.status === 503,
    );
  });
});
