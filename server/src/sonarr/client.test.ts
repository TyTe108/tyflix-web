import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  SonarrUpstreamError,
  createSonarrClient,
} from "./client";

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

function episodeRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 101,
    seasonNumber: 1,
    episodeNumber: 2,
    title: "Pilot",
    episodeFileId: 501,
    hasFile: true,
    monitored: true,
    ...overrides,
  };
}

function episodeFileRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 501,
    seasonNumber: 1,
    path: "/tv/Show/S01E02.mkv",
    size: 1_024_000,
    ...overrides,
  };
}

function seriesRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 10,
    title: "Test Show",
    qualityProfileId: 4,
    monitored: true,
    seasons: [
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: false },
      { seasonNumber: 3, monitored: true },
    ],
    ...overrides,
  };
}

describe("createSonarrClient request plumbing", () => {
  it("sends X-Api-Key on every request", async () => {
    const headersSeen: string[] = [];
    globalThis.fetch = async (_input, init) => {
      headersSeen.push(new Headers(init?.headers).get("X-Api-Key") ?? "");
      return jsonResponse(200, []);
    };

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "secret-key",
    });
    await sonarr.listEpisodes(10);
    await sonarr.listEpisodeFiles(10);

    assert.deepEqual(headersSeen, ["secret-key", "secret-key"]);
  });

  it("throws SonarrUpstreamError with upstream status on non-2xx", async () => {
    globalThis.fetch = async () => jsonResponse(503, { message: "down" });

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });

    await assert.rejects(
      () => sonarr.listEpisodes(10),
      (err: unknown) =>
        err instanceof SonarrUpstreamError &&
        err.status === 503 &&
        err.message.includes("503"),
    );
  });

  it("throws SonarrUpstreamError with status 502 when fetch rejects", async () => {
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });

    await assert.rejects(
      () => sonarr.listEpisodes(10),
      (err: unknown) =>
        err instanceof SonarrUpstreamError &&
        err.status === 502 &&
        err.message.includes("connection refused"),
    );
  });
});

describe("createSonarrClient().listEpisodes", () => {
  it("GETs /api/v3/episode?seriesId=N and maps rows", async () => {
    let call:
      | { url: string; method: string | undefined; headers: HeadersInit | undefined }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = {
        url: String(input),
        method: init?.method,
        headers: init?.headers,
      };
      return jsonResponse(200, [
        episodeRow(),
        episodeRow({
          id: 102,
          seasonNumber: 1,
          episodeNumber: 3,
          title: "Next",
          episodeFileId: 0,
          hasFile: false,
          monitored: false,
        }),
      ]);
    };

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });
    const episodes = await sonarr.listEpisodes(42);

    assert.ok(call);
    assert.equal(
      call.url,
      "http://sonarr:8989/api/v3/episode?seriesId=42",
    );
    assert.equal(call.method, "GET");
    assert.equal(new Headers(call.headers).get("X-Api-Key"), "k");
    assert.deepEqual(episodes, [
      {
        id: 101,
        seasonNumber: 1,
        episodeNumber: 2,
        title: "Pilot",
        episodeFileId: 501,
        hasFile: true,
        monitored: true,
      },
      {
        id: 102,
        seasonNumber: 1,
        episodeNumber: 3,
        title: "Next",
        episodeFileId: 0,
        hasFile: false,
        monitored: false,
      },
    ]);
  });

  it("drops rows that cannot be mapped", async () => {
    globalThis.fetch = async () =>
      jsonResponse(200, [
        episodeRow({ id: 1 }),
        episodeRow({ id: undefined, title: "Missing id" }),
        episodeRow({ id: 2, seasonNumber: "one" }),
        episodeRow({ id: 3, episodeNumber: "two" }),
        episodeRow({ id: 4, title: 99 }),
        episodeRow({ id: 5, hasFile: "yes" }),
      ]);

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });

    assert.deepEqual(await sonarr.listEpisodes(1), [
      {
        id: 1,
        seasonNumber: 1,
        episodeNumber: 2,
        title: "Pilot",
        episodeFileId: 501,
        hasFile: true,
        monitored: true,
      },
    ]);
  });
});

describe("createSonarrClient().listEpisodeFiles", () => {
  it("GETs /api/v3/episodefile?seriesId=N and maps rows", async () => {
    let call:
      | { url: string; method: string | undefined; headers: HeadersInit | undefined }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = {
        url: String(input),
        method: init?.method,
        headers: init?.headers,
      };
      return jsonResponse(200, [episodeFileRow()]);
    };

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });
    const files = await sonarr.listEpisodeFiles(42);

    assert.ok(call);
    assert.equal(
      call.url,
      "http://sonarr:8989/api/v3/episodefile?seriesId=42",
    );
    assert.equal(call.method, "GET");
    assert.equal(new Headers(call.headers).get("X-Api-Key"), "k");
    assert.deepEqual(files, [
      {
        id: 501,
        seasonNumber: 1,
        path: "/tv/Show/S01E02.mkv",
        size: 1_024_000,
      },
    ]);
  });

  it("drops rows that cannot be mapped", async () => {
    globalThis.fetch = async () =>
      jsonResponse(200, [
        episodeFileRow({ id: 1 }),
        episodeFileRow({ id: undefined }),
        episodeFileRow({ id: 2, seasonNumber: "x" }),
        episodeFileRow({ id: 3, path: 12 }),
        episodeFileRow({ id: 4, size: "big" }),
      ]);

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });

    assert.deepEqual(await sonarr.listEpisodeFiles(1), [
      {
        id: 1,
        seasonNumber: 1,
        path: "/tv/Show/S01E02.mkv",
        size: 1_024_000,
      },
    ]);
  });
});

describe("createSonarrClient().getSeries", () => {
  it("GETs /api/v3/series/{id} and returns the series", async () => {
    let call:
      | { url: string; method: string | undefined; headers: HeadersInit | undefined }
      | undefined;
    globalThis.fetch = async (input, init) => {
      call = {
        url: String(input),
        method: init?.method,
        headers: init?.headers,
      };
      return jsonResponse(200, seriesRow());
    };

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });
    const series = await sonarr.getSeries(10);

    assert.ok(call);
    assert.equal(call.url, "http://sonarr:8989/api/v3/series/10");
    assert.equal(call.method, "GET");
    assert.equal(new Headers(call.headers).get("X-Api-Key"), "k");
    assert.equal(series.id, 10);
    assert.equal(series.title, "Test Show");
    assert.deepEqual(series.seasons, [
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: false },
      { seasonNumber: 3, monitored: true },
    ]);
  });

  it("throws SonarrUpstreamError on non-2xx", async () => {
    globalThis.fetch = async () => jsonResponse(404, { message: "missing" });

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });

    await assert.rejects(
      () => sonarr.getSeries(999),
      (err: unknown) =>
        err instanceof SonarrUpstreamError && err.status === 404,
    );
  });

  it("throws SonarrUpstreamError when a season entry is unmappable", async () => {
    globalThis.fetch = async () =>
      jsonResponse(
        200,
        seriesRow({
          seasons: [
            { seasonNumber: 1, monitored: true },
            { seasonNumber: 2 },
          ],
        }),
      );

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });

    await assert.rejects(
      () => sonarr.getSeries(10),
      (err: unknown) =>
        err instanceof SonarrUpstreamError && err.status === 502,
    );
  });
});

describe("createSonarrClient().deleteEpisodeFile", () => {
  it("DELETEs /api/v3/episodefile/{id}", async () => {
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
      return jsonResponse(200, episodeFileRow({ id: 501 }));
    };

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });
    await sonarr.deleteEpisodeFile(501);

    assert.ok(call);
    assert.equal(call.url, "http://sonarr:8989/api/v3/episodefile/501");
    assert.equal(call.method, "DELETE");
    assert.equal(new Headers(call.headers).get("X-Api-Key"), "k");
  });

  it("throws SonarrUpstreamError on non-2xx", async () => {
    globalThis.fetch = async () => jsonResponse(500, { message: "boom" });

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });

    await assert.rejects(
      () => sonarr.deleteEpisodeFile(501),
      (err: unknown) =>
        err instanceof SonarrUpstreamError && err.status === 500,
    );
  });
});

describe("createSonarrClient().setEpisodesMonitored", () => {
  it("PUTs /api/v3/episode/monitor with episodeIds and monitored", async () => {
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
      return jsonResponse(200, []);
    };

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });
    await sonarr.setEpisodesMonitored([101, 102], false);

    assert.ok(call);
    assert.equal(call.url, "http://sonarr:8989/api/v3/episode/monitor");
    assert.equal(call.method, "PUT");
    assert.equal(new Headers(call.headers).get("X-Api-Key"), "k");
    assert.deepEqual(JSON.parse(call.body ?? ""), {
      episodeIds: [101, 102],
      monitored: false,
    });
  });

  it("does not make a network call when episodeIds is empty", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return jsonResponse(200, []);
    };

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });
    await sonarr.setEpisodesMonitored([], true);

    assert.equal(called, false);
  });
});

describe("createSonarrClient().setSeasonsMonitored", () => {
  it("GETs then PUTs /api/v3/series/{id} with named seasons flipped", async () => {
    const calls: Array<{
      url: string;
      method: string | undefined;
      body: string | undefined;
      headers: HeadersInit | undefined;
    }> = [];
    const fetched = seriesRow({
      path: "/tv/Test Show",
      seasons: [
        { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 1 } },
        { seasonNumber: 2, monitored: false },
        { seasonNumber: 3, monitored: true },
      ],
    });
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: init?.headers,
      });
      if (init?.method === "PUT") {
        return jsonResponse(200, {});
      }
      return jsonResponse(200, fetched);
    };

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });
    await sonarr.setSeasonsMonitored(10, [2, 3], true);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "http://sonarr:8989/api/v3/series/10");
    assert.equal(calls[0].method, "GET");
    assert.equal(new Headers(calls[0].headers).get("X-Api-Key"), "k");

    assert.equal(calls[1].url, "http://sonarr:8989/api/v3/series/10");
    assert.equal(calls[1].method, "PUT");
    assert.equal(new Headers(calls[1].headers).get("X-Api-Key"), "k");

    for (const call of calls) {
      assert.equal(call.url.includes("seasonpass"), false);
    }

    const body = JSON.parse(calls[1].body ?? "") as {
      id: number;
      title: string;
      qualityProfileId: number;
      path: string;
      seasons: Array<{
        seasonNumber: number;
        monitored: boolean;
        statistics?: unknown;
      }>;
      monitoringOptions?: unknown;
    };
    assert.equal("monitoringOptions" in body, false);
    assert.equal(body.id, 10);
    assert.equal(body.title, "Test Show");
    assert.equal(body.qualityProfileId, 4);
    assert.equal(body.path, "/tv/Test Show");
    assert.deepEqual(body.seasons, [
      {
        seasonNumber: 1,
        monitored: true,
        statistics: { episodeFileCount: 1 },
      },
      { seasonNumber: 2, monitored: true },
      { seasonNumber: 3, monitored: true },
    ]);
  });

  it("leaves seasons not in seasonNumbers untouched, including nested fields", async () => {
    let putBody:
      | {
          title: string;
          qualityProfileId: number;
          path: string;
          seasons: Array<{
            seasonNumber: number;
            monitored: boolean;
            statistics?: unknown;
          }>;
        }
      | undefined;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input).includes("seasonpass"), false);
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body)) as typeof putBody;
        return jsonResponse(200, {});
      }
      return jsonResponse(
        200,
        seriesRow({
          path: "/tv/Test Show",
          seasons: [
            {
              seasonNumber: 1,
              monitored: true,
              statistics: { episodeFileCount: 8 },
            },
            { seasonNumber: 2, monitored: false },
            {
              seasonNumber: 3,
              monitored: true,
              statistics: { episodeFileCount: 2 },
            },
          ],
        }),
      );
    };

    const sonarr = createSonarrClient({
      baseUrl: "http://sonarr:8989",
      apiKey: "k",
    });
    await sonarr.setSeasonsMonitored(10, [2], true);

    assert.ok(putBody);
    assert.equal(putBody.title, "Test Show");
    assert.equal(putBody.qualityProfileId, 4);
    assert.equal(putBody.path, "/tv/Test Show");
    assert.deepEqual(putBody.seasons, [
      {
        seasonNumber: 1,
        monitored: true,
        statistics: { episodeFileCount: 8 },
      },
      { seasonNumber: 2, monitored: true },
      {
        seasonNumber: 3,
        monitored: true,
        statistics: { episodeFileCount: 2 },
      },
    ]);
  });
});
