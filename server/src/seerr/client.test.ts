import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
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
  mock.timers.reset();
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

describe("createSeerrClient().signInWithPlex", () => {
  it("POSTs the authToken to /api/v1/auth/plex", async () => {
    let call:
      | { url: string; method: string | undefined; body: string | undefined }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = {
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      // Seerr's real success body is the *filtered* user (no plexId/email).
      return jsonResponse(200, {
        id: 9,
        plexUsername: "alice",
        displayName: "Alice",
        permissions: 2,
      });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    await seerr.signInWithPlex("plex-token-abc");

    assert.ok(call);
    assert.equal(call.url, "http://seerr:5055/api/v1/auth/plex");
    assert.equal(call.method, "POST");
    assert.deepEqual(JSON.parse(call.body ?? ""), {
      authToken: "plex-token-abc",
    });
  });

  it("returns null when the sign-in body omits plexId (onboard/token step)", async () => {
    // Verified live: Seerr filters plexId + email out of the auth/plex body,
    // so the response is not a complete SeerrUser and callers must fall back
    // to getUserByPlexId.
    globalThis.fetch = async () =>
      jsonResponse(200, {
        id: 9,
        plexUsername: "alice",
        displayName: "Alice",
        permissions: 2,
      });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    assert.equal(await seerr.signInWithPlex("plex-token-abc"), null);
  });

  it("maps and returns the user when the body is a complete SeerrUser", async () => {
    globalThis.fetch = async () =>
      jsonResponse(200, userRow({ id: 9, plexId: 42, permissions: 2 }));

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    assert.deepEqual(await seerr.signInWithPlex("plex-token-abc"), {
      id: 9,
      plexId: 42,
      plexUsername: "alice",
      displayName: "Alice",
      email: "a@example.com",
      permissions: 2,
    });
  });

  it("throws a 403 SeerrUpstreamError when Seerr refuses a non-member", async () => {
    // Live-verified: an account without Plex-server access gets 403.
    globalThis.fetch = async () =>
      jsonResponse(403, { message: "Access denied." });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () => seerr.signInWithPlex("plex-token-abc"),
      (err: unknown) =>
        err instanceof SeerrUpstreamError && err.status === 403,
    );
  });

  it("throws a 500 SeerrUpstreamError for an unauthenticated/invalid token", async () => {
    // Live-verified: a bogus Plex token yields 500 "Unable to authenticate.".
    globalThis.fetch = async () =>
      jsonResponse(500, { message: "Unable to authenticate." });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () => seerr.signInWithPlex("bogus"),
      (err: unknown) =>
        err instanceof SeerrUpstreamError && err.status === 500,
    );
  });
});

describe("createSeerrClient().getUserById", () => {
  it("GETs /api/v1/user/:id with X-Api-Key and returns the mapped user", async () => {
    const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({
        url: String(input),
        headers: init?.headers,
      });
      return jsonResponse(200, userRow({ id: 9, plexId: 42, permissions: 2 }));
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "secret-key",
    });
    const user = await seerr.getUserById(9);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://seerr:5055/api/v1/user/9");
    const headers = new Headers(calls[0].headers);
    assert.equal(headers.get("X-Api-Key"), "secret-key");
    assert.deepEqual(user, {
      id: 9,
      plexId: 42,
      plexUsername: "alice",
      displayName: "Alice",
      email: "a@example.com",
      permissions: 2,
    });
  });

  it("returns null on 404 (account no longer exists)", async () => {
    globalThis.fetch = async () =>
      jsonResponse(404, { message: "User not found." });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    assert.equal(await seerr.getUserById(999999), null);
  });

  it("throws SeerrUpstreamError on transport failure", async () => {
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    await assert.rejects(
      () => seerr.getUserById(1),
      (err: unknown) =>
        err instanceof SeerrUpstreamError && err.status === 502,
    );
  });

  it("rejects with forwarded status on 500 (not null / not_found)", async () => {
    // null would be classified as not_found -> 401 for every user; a Seerr
    // outage must stay a throw so revalidation maps it to 503.
    globalThis.fetch = async () => jsonResponse(500, { message: "boom" });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    await assert.rejects(
      () => seerr.getUserById(1),
      (err: unknown) =>
        err instanceof SeerrUpstreamError && err.status === 500,
    );
  });

  it("rejects with forwarded status on 403 (not null / not_found)", async () => {
    globalThis.fetch = async () => jsonResponse(403, { message: "forbidden" });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    await assert.rejects(
      () => seerr.getUserById(1),
      (err: unknown) =>
        err instanceof SeerrUpstreamError && err.status === 403,
    );
  });

  it("rejects with 502 on an unmappable 200 body (not null / not_found)", async () => {
    globalThis.fetch = async () => jsonResponse(200, { id: "nope" });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    await assert.rejects(
      () => seerr.getUserById(1),
      (err: unknown) =>
        err instanceof SeerrUpstreamError && err.status === 502,
    );
  });

  it("passes an AbortSignal to fetch (timeout wiring)", async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = async (_input, init) => {
      signal = init?.signal ?? undefined;
      return jsonResponse(200, userRow({ id: 1 }));
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    await seerr.getUserById(1);

    assert.ok(signal instanceof AbortSignal);
  });
});

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

describe("createSeerrClient().getUserQuota", () => {
  it("maps movie and TV quota axes", async () => {
    globalThis.fetch = async (input) => {
      assert.equal(
        String(input),
        "http://seerr:5055/api/v1/user/44/quota",
      );
      return jsonResponse(200, {
        movie: { days: 7, limit: 5, used: 2, restricted: false },
        tv: { days: 30, limit: 0, used: 0, restricted: false },
      });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    assert.deepEqual(await seerr.getUserQuota(44), {
      movie: { days: 7, limit: 5, used: 2, restricted: false },
      tv: { days: 30, limit: 0, used: 0, restricted: false },
    });
  });

  it("throws a 502 SeerrUpstreamError for an unexpected quota shape", async () => {
    globalThis.fetch = async () =>
      jsonResponse(200, {
        movie: { days: 7, limit: "five", used: 2, restricted: false },
        tv: { days: 30, limit: 0, used: 0, restricted: false },
      });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () => seerr.getUserQuota(44),
      (err: unknown) =>
        err instanceof SeerrUpstreamError &&
        err.status === 502 &&
        err.message.includes("unexpected body"),
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
            {
              id: 10,
              tmdbId: 603,
              mediaType: "movie",
              status: 5,
              tvdbId: null,
              ratingKey: "12345",
            },
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
      {
        id: 10,
        tmdbId: 603,
        mediaType: "movie",
        status: 5,
        ratingKey: "12345",
        tvdbId: null,
        externalServiceId: null,
        seasons: [],
      },
      {
        id: 20,
        tmdbId: 1396,
        mediaType: "tv",
        status: 4,
        ratingKey: null,
        tvdbId: null,
        externalServiceId: null,
        seasons: [],
      },
    ]);
    assert.deepEqual(calls, ["?take=100&skip=0", "?take=100&skip=100"]);
  });

  it("extracts ratingKey leniently without dropping items", async () => {
    globalThis.fetch = async () =>
      jsonResponse(200, {
        pageInfo: { results: 4 },
        results: [
          // string ratingKey → used as-is
          { id: 1, tmdbId: 603, mediaType: "movie", status: 5, ratingKey: "12345" },
          // number ratingKey → String(n)
          { id: 2, tmdbId: 1396, mediaType: "tv", status: 4, ratingKey: 67890 },
          // missing ratingKey → null, item kept
          { id: 3, tmdbId: 700, mediaType: "movie", status: 5 },
          // odd ratingKey → null, item kept
          {
            id: 4,
            tmdbId: 701,
            mediaType: "movie",
            status: 5,
            ratingKey: { nope: true },
          },
        ],
      });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    assert.deepEqual(await seerr.listMedia(), [
      {
        id: 1,
        tmdbId: 603,
        mediaType: "movie",
        status: 5,
        ratingKey: "12345",
        tvdbId: null,
        externalServiceId: null,
        seasons: [],
      },
      {
        id: 2,
        tmdbId: 1396,
        mediaType: "tv",
        status: 4,
        ratingKey: "67890",
        tvdbId: null,
        externalServiceId: null,
        seasons: [],
      },
      {
        id: 3,
        tmdbId: 700,
        mediaType: "movie",
        status: 5,
        ratingKey: null,
        tvdbId: null,
        externalServiceId: null,
        seasons: [],
      },
      {
        id: 4,
        tmdbId: 701,
        mediaType: "movie",
        status: 5,
        ratingKey: null,
        tvdbId: null,
        externalServiceId: null,
        seasons: [],
      },
    ]);
  });

  it("keeps a media row when tvdbId is entirely absent (tvdbId null)", async () => {
    globalThis.fetch = async () =>
      jsonResponse(200, {
        pageInfo: { results: 1 },
        results: [
          {
            id: 11,
            tmdbId: 604,
            mediaType: "movie",
            status: 5,
            ratingKey: "1",
          },
        ],
      });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    assert.deepEqual(await seerr.listMedia(), [
      {
        id: 11,
        tmdbId: 604,
        mediaType: "movie",
        status: 5,
        ratingKey: "1",
        tvdbId: null,
        externalServiceId: null,
        seasons: [],
      },
    ]);
  });

  it("keeps a media row when tvdbId is a non-numeric string (tvdbId null)", async () => {
    globalThis.fetch = async () =>
      jsonResponse(200, {
        pageInfo: { results: 1 },
        results: [
          {
            id: 10,
            tmdbId: 603,
            mediaType: "movie",
            status: 5,
            ratingKey: "1",
            tvdbId: "nope",
          },
        ],
      });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    assert.deepEqual(await seerr.listMedia(), [
      {
        id: 10,
        tmdbId: 603,
        mediaType: "movie",
        status: 5,
        ratingKey: "1",
        tvdbId: null,
        externalServiceId: null,
        seasons: [],
      },
    ]);
  });

  it("maps tvdbId, externalServiceId, and seasons best-effort", async () => {
    globalThis.fetch = async () =>
      jsonResponse(200, {
        pageInfo: { results: 3 },
        results: [
          {
            id: 317,
            tmdbId: 83118,
            tvdbId: 353544,
            mediaType: "tv",
            status: 4,
            externalServiceId: 97,
            ratingKey: "7171",
            seasons: [
              { id: 545, seasonNumber: 0, status: 1 },
              { id: 546, seasonNumber: 1, status: 5 },
              { seasonNumber: "bad", status: 5 },
              { seasonNumber: 2 },
            ],
          },
          {
            id: 10,
            tmdbId: 603,
            mediaType: "movie",
            status: 5,
            tvdbId: "nope",
            externalServiceId: { odd: true },
            seasons: "nope",
          },
          {
            id: 11,
            tmdbId: 604,
            mediaType: "movie",
            status: 5,
          },
        ],
      });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    assert.deepEqual(await seerr.listMedia(), [
      {
        id: 317,
        tmdbId: 83118,
        mediaType: "tv",
        status: 4,
        ratingKey: "7171",
        tvdbId: 353544,
        externalServiceId: 97,
        seasons: [
          { seasonNumber: 0, status: 1 },
          { seasonNumber: 1, status: 5 },
        ],
      },
      {
        id: 10,
        tmdbId: 603,
        mediaType: "movie",
        status: 5,
        ratingKey: null,
        tvdbId: null,
        externalServiceId: null,
        seasons: [],
      },
      {
        id: 11,
        tmdbId: 604,
        mediaType: "movie",
        status: 5,
        ratingKey: null,
        tvdbId: null,
        externalServiceId: null,
        seasons: [],
      },
    ]);
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

  it("creates an issue with numeric type, X-API-User, and problem location", async () => {
    let call:
      | {
          url: string;
          method: string | undefined;
          body: string | undefined;
          headers: HeadersInit | undefined;
        }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = {
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: init?.headers,
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
    assert.equal(new Headers(call.headers).get("X-API-User"), "44");
    assert.deepEqual(JSON.parse(call.body ?? ""), {
      issueType: 3,
      message: "Subtitle timing is wrong",
      mediaId: 10,
      problemSeason: 2,
      problemEpisode: 3,
    });
  });

  it("throws before calling Seerr when createIssue userId is not a positive integer", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return jsonResponse(201, issueRow());
    };
    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () =>
        seerr.createIssue({
          issueType: "video",
          message: "Broken",
          mediaId: 10,
          userId: 0,
        }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("createIssue requires a positive integer userId"),
    );
    assert.equal(called, false);
  });

  it("adds an issue comment with X-API-User", async () => {
    let call:
      | {
          url: string;
          method: string | undefined;
          body: string | undefined;
          headers: HeadersInit | undefined;
        }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = {
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: init?.headers,
      };
      return jsonResponse(200, issueRow());
    };
    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await seerr.addIssueComment(51, "More detail", 7);

    assert.ok(call);
    assert.equal(call.url, "http://seerr:5055/api/v1/issue/51/comment");
    assert.equal(call.method, "POST");
    assert.equal(new Headers(call.headers).get("X-API-User"), "7");
    assert.deepEqual(JSON.parse(call.body ?? ""), { message: "More detail" });
  });

  it("throws before calling Seerr when addIssueComment userId is not a positive integer", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return jsonResponse(200, issueRow());
    };
    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () => seerr.addIssueComment(51, "More detail", -1),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes(
          "addIssueComment requires a positive integer userId",
        ),
    );
    assert.equal(called, false);
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
      const view = toRequestView(requestRow({ status }), {
        title: "The Matrix",
        posterUrl: null,
      });
      assert.equal(view.requestStatus, requestStatuses[status - 1]);
    }
    for (let status = 1; status <= mediaStatuses.length; status += 1) {
      const request = requestRow({
        media: { ...requestRow().media, status },
      });
      const view = toRequestView(request, {
        title: "The Matrix",
        posterUrl: "https://img/poster.jpg",
      });
      assert.equal(view.mediaStatus, mediaStatuses[status - 1]);
      assert.equal(view.posterUrl, "https://img/poster.jpg");
      assert.equal(view.createdAt, "2026-07-15T00:00:00.000Z");
      assert.equal(view.updatedAt, "2026-07-15T01:00:00.000Z");
    }
  });

  it("creates a TV request without profile overrides when none are provided", async () => {
    let call:
      | {
          url: string;
          method: string | undefined;
          body: string | undefined;
          headers: HeadersInit | undefined;
        }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = {
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: init?.headers,
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
    assert.equal(new Headers(call.headers).get("X-API-User"), "7");
    assert.deepEqual(JSON.parse(call.body ?? ""), {
      mediaType: "tv",
      mediaId: 1396,
      seasons: [1, 2],
    });
  });

  it("includes profileId and serverId when provided", async () => {
    let body: Record<string, unknown> | undefined;
    let headers: HeadersInit | undefined;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      headers = init?.headers;
      return jsonResponse(201, requestRow());
    };
    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await seerr.createRequest({
      mediaType: "movie",
      tmdbId: 603,
      userId: 7,
      profileId: 4,
      serverId: 12,
    });

    assert.equal(new Headers(headers).get("X-API-User"), "7");
    assert.deepEqual(body, {
      mediaType: "movie",
      mediaId: 603,
      profileId: 4,
      serverId: 12,
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

describe("createSeerrClient().getServiceProfiles", () => {
  it("uses radarr for movies and picks the default server", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/v1/service/radarr")) {
        return jsonResponse(200, [
          { id: 0, name: "Primary", isDefault: false },
          { id: 12, name: "Default", isDefault: true },
        ]);
      }
      return jsonResponse(200, {
        server: { id: 12, activeProfileId: 4 },
        profiles: [
          { id: 1, name: "Any" },
          { id: 4, name: "HD-1080p" },
        ],
        rootFolders: [{ id: 1, path: "/movies" }],
      });
    };
    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    assert.deepEqual(await seerr.getServiceProfiles("movie"), {
      serverId: 12,
      defaultProfileId: 4,
      profiles: [
        { id: 1, name: "Any" },
        { id: 4, name: "HD-1080p" },
      ],
    });
    assert.deepEqual(calls, [
      "http://seerr:5055/api/v1/service/radarr",
      "http://seerr:5055/api/v1/service/radarr/12",
    ]);
  });

  it("uses sonarr for TV and falls back to the first server", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/v1/service/sonarr")) {
        return jsonResponse(200, [
          { id: 3, name: "TV", isDefault: false },
          { id: 4, name: "Other", isDefault: false },
        ]);
      }
      return jsonResponse(200, {
        server: { id: 3, activeProfileId: 6 },
        profiles: [{ id: 6, name: "HD-720p/1080p" }],
        rootFolders: [],
      });
    };
    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    assert.deepEqual(await seerr.getServiceProfiles("tv"), {
      serverId: 3,
      defaultProfileId: 6,
      profiles: [{ id: 6, name: "HD-720p/1080p" }],
    });
    assert.deepEqual(calls, [
      "http://seerr:5055/api/v1/service/sonarr",
      "http://seerr:5055/api/v1/service/sonarr/3",
    ]);
  });

  it("throws a 502 for an unexpected service shape", async () => {
    globalThis.fetch = async () =>
      jsonResponse(200, [{ id: "bad", isDefault: true }]);
    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () => seerr.getServiceProfiles("movie"),
      (err: unknown) =>
        err instanceof SeerrUpstreamError && err.status === 502,
    );
  });
});

describe("createSeerrClient().deleteMediaFile", () => {
  it("DELETEs /api/v1/media/{id}/file and resolves on 204", async () => {
    let call:
      | {
          url: string;
          method: string | undefined;
          headers: HeadersInit | undefined;
        }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = {
        url: String(input),
        method: init?.method,
        headers: init?.headers,
      };
      return new Response(null, { status: 204 });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    await seerr.deleteMediaFile(317);

    assert.ok(call);
    assert.equal(call.url, "http://seerr:5055/api/v1/media/317/file");
    assert.equal(call.method, "DELETE");
    assert.equal(new Headers(call.headers).get("X-Api-Key"), "k");
  });

  it("sends is4k as a query param only when passed", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return new Response(null, { status: 204 });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    await seerr.deleteMediaFile(317, { is4k: true });
    await seerr.deleteMediaFile(317);

    assert.equal(urls[0], "http://seerr:5055/api/v1/media/317/file?is4k=true");
    assert.equal(urls[1], "http://seerr:5055/api/v1/media/317/file");
  });

  it("throws SeerrUpstreamError with status 504 when the request times out", async () => {
    globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () => seerr.deleteMediaFile(317, { timeoutMs: 20 }),
      (err: unknown) =>
        err instanceof SeerrUpstreamError && err.status === 504,
    );
  });

  it("applies the default 15s timeout when called with no options", async (t) => {
    // Default is 15s; mock timers so the suite does not wait wall-clock time.
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let signal: AbortSignal | undefined;
    globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    const pending = seerr.deleteMediaFile(317);

    assert.ok(signal);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(15_000);
    assert.equal(signal.aborted, true);

    await assert.rejects(
      () => pending,
      (err: unknown) =>
        err instanceof SeerrUpstreamError && err.status === 504,
    );
  });

  it("throws SeerrUpstreamError with upstream status on non-2xx", async () => {
    globalThis.fetch = async () => jsonResponse(500, { message: "boom" });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () => seerr.deleteMediaFile(317),
      (err: unknown) =>
        err instanceof SeerrUpstreamError && err.status === 500,
    );
  });
});

describe("createSeerrClient().deleteMedia", () => {
  it("DELETEs /api/v1/media/{id} and resolves on 204", async () => {
    let call:
      | { url: string; method: string | undefined }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = { url: String(input), method: init?.method };
      return new Response(null, { status: 204 });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    await seerr.deleteMedia(317);

    assert.ok(call);
    assert.equal(call.url, "http://seerr:5055/api/v1/media/317");
    assert.equal(call.method, "DELETE");
  });
});

describe("createSeerrClient().listBlocklist", () => {
  it("GETs one page, maps rows, skips malformed, and returns total", async () => {
    let call:
      | { url: string; method: string | undefined; headers: HeadersInit | undefined }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = {
        url: String(input),
        method: init?.method,
        headers: init?.headers,
      };
      return jsonResponse(200, {
        pageInfo: { pages: 1, pageSize: 20, results: 3, page: 1 },
        results: [
          {
            id: 1,
            tmdbId: 603,
            mediaType: "movie",
            title: "The Matrix",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
          { id: 2, tmdbId: "bad", mediaType: "movie", title: "Nope" },
          {
            id: 3,
            tmdbId: 1396,
            mediaType: "tv",
            title: "Breaking Bad",
          },
        ],
      });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "secret",
    });
    const page = await seerr.listBlocklist({
      take: 20,
      skip: 0,
      search: "matrix",
    });

    assert.ok(call);
    assert.equal(
      call.url,
      "http://seerr:5055/api/v1/blocklist?take=20&skip=0&search=matrix",
    );
    assert.equal(call.method, "GET");
    assert.equal(new Headers(call.headers).get("X-Api-Key"), "secret");
    assert.deepEqual(page, {
      total: 3,
      results: [
        { id: 1, tmdbId: 603, mediaType: "movie", title: "The Matrix" },
        { id: 3, tmdbId: 1396, mediaType: "tv", title: "Breaking Bad" },
      ],
    });
  });

  it("omits take, skip, and search when not passed", async () => {
    let url = "";
    globalThis.fetch = async (input) => {
      url = String(input);
      return jsonResponse(200, {
        pageInfo: { results: 0 },
        results: [],
      });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    await seerr.listBlocklist();

    assert.equal(url, "http://seerr:5055/api/v1/blocklist");
  });
});

describe("createSeerrClient().addToBlocklist", () => {
  it("POSTs body with user (not userId) and no X-API-User header", async () => {
    let call:
      | {
          url: string;
          method: string | undefined;
          body: string | undefined;
          headers: HeadersInit | undefined;
        }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = {
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: init?.headers,
      };
      return new Response(null, { status: 201 });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    await seerr.addToBlocklist({
      tmdbId: 603,
      mediaType: "movie",
      title: "The Matrix",
      userId: 7,
    });

    assert.ok(call);
    assert.equal(call.url, "http://seerr:5055/api/v1/blocklist");
    assert.equal(call.method, "POST");
    const headers = new Headers(call.headers);
    assert.equal(headers.get("X-Api-Key"), "k");
    assert.equal(headers.get("X-API-User"), null);
    assert.deepEqual(JSON.parse(call.body ?? ""), {
      tmdbId: 603,
      mediaType: "movie",
      title: "The Matrix",
      user: 7,
    });
  });

  it("omits title when not provided", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 201 });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    await seerr.addToBlocklist({
      tmdbId: 1396,
      mediaType: "tv",
      userId: 7,
    });

    assert.deepEqual(body, {
      tmdbId: 1396,
      mediaType: "tv",
      user: 7,
    });
  });

  it("throws before calling Seerr when userId is not a positive integer", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response(null, { status: 201 });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () =>
        seerr.addToBlocklist({
          tmdbId: 603,
          mediaType: "movie",
          userId: 0,
        }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("addToBlocklist requires a positive integer userId"),
    );
    assert.equal(called, false);
  });

  it("throws SeerrUpstreamError with status 412 on duplicate", async () => {
    globalThis.fetch = async () =>
      jsonResponse(412, { message: "Item already blocklisted" });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () =>
        seerr.addToBlocklist({
          tmdbId: 603,
          mediaType: "movie",
          userId: 7,
        }),
      (err: unknown) =>
        err instanceof SeerrUpstreamError && err.status === 412,
    );
  });
});

describe("createSeerrClient().removeFromBlocklist", () => {
  it("DELETEs /api/v1/blocklist/{tmdbId}?mediaType= and reports a clean 204", async () => {
    let call:
      | { url: string; method: string | undefined }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = { url: String(input), method: init?.method };
      return new Response(null, { status: 204 });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    const result = await seerr.removeFromBlocklist(603, "movie");

    assert.ok(call);
    assert.equal(
      call.url,
      "http://seerr:5055/api/v1/blocklist/603?mediaType=movie",
    );
    assert.equal(call.method, "DELETE");
    assert.deepEqual(result, { mediaRowDeleted: true });
  });

  it("resolves a 404 as mediaRowDeleted false (partial delete)", async () => {
    globalThis.fetch = async () =>
      jsonResponse(404, { message: "Media not found" });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    const result = await seerr.removeFromBlocklist(603, "movie");

    assert.deepEqual(result, { mediaRowDeleted: false });
  });

  it("throws SeerrUpstreamError on other non-2xx statuses", async () => {
    globalThis.fetch = async () => jsonResponse(500, { message: "boom" });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () => seerr.removeFromBlocklist(603, "tv"),
      (err: unknown) =>
        err instanceof SeerrUpstreamError && err.status === 500,
    );
  });
});
