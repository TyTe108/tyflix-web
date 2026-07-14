import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { RadarrUpstreamError, createRadarrClient } from "./client";

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

function recordCalls(): Call[] {
  const calls: Call[] = [];
  return calls;
}

describe("createRadarrClient().addMovie", () => {
  it("POSTs /movie when not in library", async () => {
    const calls: Call[] = recordCalls();
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

      if (url.includes("/movie/lookup")) {
        return jsonResponse(200, [
          {
            title: "The Matrix",
            tmdbId: 603,
            year: 1999,
            hasFile: false,
            monitored: false,
          },
        ]);
      }
      if (method === "POST" && url.includes("/movie")) {
        return jsonResponse(200, {
          id: 10,
          title: "The Matrix",
          tmdbId: 603,
          year: 1999,
          hasFile: false,
          monitored: true,
        });
      }
      return jsonResponse(500, { error: "unexpected" });
    };

    const radarr = createRadarrClient({
      url: "http://radarr:7878",
      apiKey: "radarr-key",
    });

    const result = await radarr.addMovie({
      tmdbId: 603,
      title: "The Matrix",
      year: 1999,
      qualityProfileId: 4,
      rootFolderPath: "/movies",
      minimumAvailability: "released",
    });

    assert.equal(result.id, 10);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/api\/v3\/movie\/lookup\?term=tmdb%3A603/);
    assert.equal(
      new Headers(calls[0].headers).get("X-Api-Key"),
      "radarr-key",
    );

    const post = calls[1];
    assert.equal(post.method, "POST");
    assert.match(post.url, /\/api\/v3\/movie$/);
    assert.notEqual(post.body, null);
    assert.equal(post.body!.tmdbId, 603);
    assert.equal(post.body!.qualityProfileId, 4);
    assert.equal(post.body!.rootFolderPath, "/movies");
    assert.equal(post.body!.titleSlug, "603");
    assert.deepEqual(post.body!.tags, []);
    assert.equal(
      (post.body!.addOptions as { searchForMovie: boolean }).searchForMovie,
      true,
    );
  });

  it("returns existing and skips POST/PUT when hasFile", async () => {
    const calls: Call[] = recordCalls();
    globalThis.fetch = async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        headers: init?.headers,
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null,
      });
      return jsonResponse(200, [
        {
          id: 7,
          title: "The Matrix",
          tmdbId: 603,
          year: 1999,
          hasFile: true,
          monitored: true,
        },
      ]);
    };

    const radarr = createRadarrClient({
      url: "http://radarr:7878",
      apiKey: "k",
    });

    const result = await radarr.addMovie({
      tmdbId: 603,
      title: "The Matrix",
      year: 1999,
      qualityProfileId: 4,
      rootFolderPath: "/movies",
      minimumAvailability: "released",
    });

    assert.equal(result.id, 7);
    assert.equal(result.hasFile, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/movie\/lookup/);
  });

  it("throws RadarrUpstreamError on non-2xx", async () => {
    globalThis.fetch = async () => jsonResponse(503, { message: "down" });

    const radarr = createRadarrClient({
      url: "http://radarr:7878",
      apiKey: "k",
    });

    await assert.rejects(
      () =>
        radarr.addMovie({
          tmdbId: 1,
          title: "X",
          year: 2000,
          qualityProfileId: 1,
          rootFolderPath: "/movies",
          minimumAvailability: "released",
        }),
      (err: unknown) =>
        err instanceof RadarrUpstreamError &&
        err.status === 503 &&
        err.message.includes("503"),
    );
  });
});
