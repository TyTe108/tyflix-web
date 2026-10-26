import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { inspect } from "node:util";
import { createTmdbClient, type MovieDetail, type TvDetail } from "./client";
import { createMediaEnrichment } from "./enrichment";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createMediaEnrichment", () => {
  it("dedupes, caches successful details, and omits failed details", async () => {
    const originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    try {
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
    } finally {
      console.warn = originalConsoleWarn;
    }
  });

  it("warns once, naming the first failure in input order", async () => {
    const pending: Array<{ key: string; reject: (err: Error) => void }> = [];
    const enrichment = createMediaEnrichment({
      async movieDetail(id) {
        const key = `movie:${id}`;
        if (id === 1 || id === 3) {
          return await new Promise<MovieDetail>((_resolve, reject) => {
            pending.push({ key, reject });
            if (pending.length < 2) {
              return;
            }
            const later = pending.find((entry) => entry.key === "movie:3");
            const earlier = pending.find((entry) => entry.key === "movie:1");
            queueMicrotask(() => {
              later?.reject(new Error("later failure"));
              queueMicrotask(() => {
                earlier?.reject(new Error("rate limited"));
              });
            });
          });
        }
        return movieDetailValue(id);
      },
      async tvDetail(id) {
        return tvDetailValue(id);
      },
    });
    const capture = captureWarn();
    try {
      await enrichment.enrich([
        { mediaType: "movie", tmdbId: 1 },
        { mediaType: "movie", tmdbId: 1 },
        { mediaType: "tv", tmdbId: 2 },
        { mediaType: "movie", tmdbId: 3 },
        { mediaType: "tv", tmdbId: 4 },
      ]);
    } finally {
      capture.restore();
    }

    assert.equal(capture.args.length, 1);
    assert.deepEqual(capture.args[0], [
      "TMDB enrichment: 2 of 4 lookups failed; first error: rate limited",
    ]);
  });

  it("does not warn when every lookup succeeds or comes from cache", async () => {
    const calls: string[] = [];
    const enrichment = createMediaEnrichment({
      async movieDetail(id) {
        calls.push(`movie:${id}`);
        return movieDetailValue(id);
      },
      async tvDetail(id) {
        calls.push(`tv:${id}`);
        return tvDetailValue(id);
      },
    });
    const capture = captureWarn();
    try {
      await enrichment.enrich([{ mediaType: "movie", tmdbId: 100 }]);
      assert.deepEqual(capture.args, []);
      await enrichment.enrich([{ mediaType: "movie", tmdbId: 100 }]);
      assert.deepEqual(capture.args, []);
      assert.deepEqual(calls, ["movie:100"]);
    } finally {
      capture.restore();
    }
  });

  it("logs the error message and not the request URL on its cause", async () => {
    const err = new Error("lookup failed");
    err.cause = { url: "https://tmdb.test/x?api_key=SECRET" };
    const enrichment = createMediaEnrichment({
      async movieDetail() {
        throw err;
      },
      async tvDetail() {
        throw new Error("unused");
      },
    });
    const capture = captureWarn();
    try {
      await enrichment.enrich([{ mediaType: "movie", tmdbId: 300 }]);
    } finally {
      capture.restore();
    }

    assert.equal(capture.args.length, 1);
    const recorded = capture.args
      .flat()
      .map((arg) => inspect(arg))
      .join(" ");
    assert.equal(recorded.includes("SECRET"), false);
    assert.equal(recorded.includes("api_key"), false);
  });
});

function captureWarn(): { args: unknown[][]; restore: () => void } {
  const args: unknown[][] = [];
  const original = console.warn;
  console.warn = (...received: unknown[]) => {
    args.push(received);
  };
  return {
    args,
    restore() {
      console.warn = original;
    },
  };
}

function movieDetailValue(id: number): MovieDetail {
  return {
    tmdbId: id,
    mediaType: "movie",
    title: `Stub Movie ${id}`,
    year: null,
    overview: "",
    posterUrl: `https://posters.test/movie/${id}.jpg`,
    backdropUrl: null,
    runtime: null,
    genres: [],
    status: "",
    collection: null,
  };
}

function tvDetailValue(id: number): TvDetail {
  return {
    tmdbId: id,
    mediaType: "tv",
    title: `Stub Show ${id}`,
    year: null,
    overview: "",
    posterUrl: `https://posters.test/tv/${id}.jpg`,
    backdropUrl: null,
    genres: [],
    status: "",
    tvdbId: null,
    seasons: [],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
