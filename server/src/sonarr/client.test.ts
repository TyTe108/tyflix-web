import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SonarrUpstreamError, createSonarrClient } from "./client";

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

type Call = {
  method: string;
  url: string;
  headers: HeadersInit | undefined;
  body: Record<string, unknown> | null;
};

describe("createSonarrClient().addSeries", () => {
  it("POSTs /series when not in library with requested seasons monitored", async () => {
    const calls: Call[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      calls.push({
        method,
        url,
        headers: init?.headers,
        body,
      });

      if (url.includes("/series/lookup")) {
        return jsonResponse(200, [
          {
            title: "Breaking Bad",
            tvdbId: 81189,
            monitored: false,
            seasons: [
              { seasonNumber: 0, monitored: false },
              { seasonNumber: 1, monitored: false },
              { seasonNumber: 2, monitored: false },
              { seasonNumber: 3, monitored: false },
            ],
          },
        ]);
      }
      if (method === "POST" && url.includes("/series")) {
        return jsonResponse(200, {
          id: 20,
          title: "Breaking Bad",
          tvdbId: 81189,
          monitored: true,
          seasons: body?.seasons,
        });
      }
      return jsonResponse(500, { error: "unexpected" });
    };

    const sonarr = createSonarrClient({
      url: "http://sonarr:8989",
      apiKey: "sonarr-key",
    });

    const result = await sonarr.addSeries({
      tvdbId: 81189,
      title: "Breaking Bad",
      qualityProfileId: 5,
      languageProfileId: 1,
      seasons: [1, 2],
      rootFolderPath: "/tv",
    });

    assert.equal(result.id, 20);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/api\/v3\/series\/lookup\?term=tvdb%3A81189/);
    assert.equal(
      new Headers(calls[0].headers).get("X-Api-Key"),
      "sonarr-key",
    );

    const post = calls[1];
    assert.equal(post.method, "POST");
    assert.match(post.url, /\/api\/v3\/series$/);
    assert.notEqual(post.body, null);
    assert.equal(post.body!.tvdbId, 81189);
    assert.equal(post.body!.qualityProfileId, 5);
    assert.equal(post.body!.rootFolderPath, "/tv");
    assert.equal(
      (post.body!.addOptions as { searchForMissingEpisodes: boolean })
        .searchForMissingEpisodes,
      true,
    );
    assert.equal(
      (post.body!.addOptions as { ignoreEpisodesWithFiles: boolean })
        .ignoreEpisodesWithFiles,
      true,
    );
    assert.deepEqual(post.body!.seasons, [
      { seasonNumber: 0, monitored: false },
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: true },
      { seasonNumber: 3, monitored: false },
    ]);
  });

  it("PUTs /series when already in Sonarr", async () => {
    const calls: Call[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      calls.push({
        method,
        url,
        headers: init?.headers,
        body,
      });

      if (url.includes("/series/lookup")) {
        return jsonResponse(200, [
          {
            id: 33,
            title: "Breaking Bad",
            tvdbId: 81189,
            monitored: false,
            seasons: [
              { seasonNumber: 1, monitored: false },
              { seasonNumber: 2, monitored: false },
            ],
          },
        ]);
      }
      if (method === "PUT" && url.includes("/series")) {
        return jsonResponse(200, {
          ...body,
          id: 33,
        });
      }
      return jsonResponse(500, { error: "unexpected" });
    };

    const sonarr = createSonarrClient({
      url: "http://sonarr:8989",
      apiKey: "k",
    });

    const result = await sonarr.addSeries({
      tvdbId: 81189,
      title: "Breaking Bad",
      qualityProfileId: 5,
      seasons: [2],
      rootFolderPath: "/tv",
    });

    assert.equal(result.id, 33);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, "PUT");
    assert.match(calls[1].url, /\/api\/v3\/series$/);
    assert.notEqual(calls[1].body, null);
    assert.equal(calls[1].body!.monitored, true);
    assert.deepEqual(calls[1].body!.seasons, [
      { seasonNumber: 1, monitored: false },
      { seasonNumber: 2, monitored: true },
    ]);
  });

  it("throws SonarrUpstreamError on non-2xx", async () => {
    globalThis.fetch = async () => jsonResponse(502, { message: "down" });

    const sonarr = createSonarrClient({
      url: "http://sonarr:8989",
      apiKey: "k",
    });

    await assert.rejects(
      () =>
        sonarr.addSeries({
          tvdbId: 1,
          title: "X",
          qualityProfileId: 1,
          seasons: [1],
          rootFolderPath: "/tv",
        }),
      (err: unknown) =>
        err instanceof SonarrUpstreamError &&
        err.status === 502 &&
        err.message.includes("502"),
    );
  });
});
