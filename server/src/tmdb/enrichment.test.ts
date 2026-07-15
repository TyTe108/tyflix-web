import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createTmdbClient } from "./client";
import { createMediaEnrichment } from "./enrichment";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createMediaEnrichment", () => {
  it("dedupes, caches successful details, and omits failed details", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith("/movie/603")) {
        return jsonResponse(200, {
          id: 603,
          title: "The Matrix",
          poster_path: "/matrix.jpg",
        });
      }
      if (url.pathname.endsWith("/tv/1396")) {
        return jsonResponse(503, { status_message: "unavailable" });
      }
      return jsonResponse(404, {});
    };

    const enrichment = createMediaEnrichment(
      createTmdbClient({ apiKey: "test-key" }),
    );
    const items = [
      { mediaType: "movie" as const, tmdbId: 603 },
      { mediaType: "movie" as const, tmdbId: 603 },
      { mediaType: "tv" as const, tmdbId: 1396 },
    ];

    const first = await enrichment.enrich(items);
    assert.deepEqual([...first], [
      [
        "movie:603",
        {
          title: "The Matrix",
          posterUrl: "https://image.tmdb.org/t/p/w500/matrix.jpg",
        },
      ],
    ]);
    assert.deepEqual(calls.sort(), ["/3/movie/603", "/3/tv/1396"]);

    const second = await enrichment.enrich(items);
    assert.deepEqual(second, first);
    assert.equal(
      calls.filter((path) => path === "/3/movie/603").length,
      1,
    );
    assert.equal(calls.filter((path) => path === "/3/tv/1396").length, 2);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
