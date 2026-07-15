import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  TmdbUpstreamError,
  createTmdbClient,
  mapMediaSummary,
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

describe("createTmdbClient().search", () => {
  it("maps fields, drops person, builds posterUrl, and derives year", async () => {
    const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({
        url: String(input),
        headers: init?.headers,
      });
      return jsonResponse(200, {
        page: 1,
        total_pages: 3,
        results: [
          {
            media_type: "movie",
            id: 603,
            title: "The Matrix",
            release_date: "1999-03-31",
            poster_path: "/matrix.jpg",
            overview: "Neo wakes up.",
          },
          {
            media_type: "tv",
            id: 1396,
            name: "Breaking Bad",
            first_air_date: "2008-01-20",
            poster_path: null,
            overview: "Chemistry teacher goes dark.",
          },
          {
            media_type: "person",
            id: 1,
            name: "Keanu Reeves",
            profile_path: "/keanu.jpg",
          },
        ],
      });
    };

    const tmdb = createTmdbClient({ apiKey: "secret-key" });
    const result = await tmdb.search("matrix");

    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, "https://api.themoviedb.org/3/search/multi");
    assert.equal(url.searchParams.get("api_key"), "secret-key");
    assert.equal(url.searchParams.get("query"), "matrix");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("include_adult"), "false");
    const headers = new Headers(calls[0].headers);
    assert.equal(headers.get("Accept"), "application/json");

    assert.deepEqual(result, {
      page: 1,
      totalPages: 3,
      results: [
        {
          tmdbId: 603,
          mediaType: "movie",
          title: "The Matrix",
          year: 1999,
          posterUrl: "https://image.tmdb.org/t/p/w500/matrix.jpg",
          overview: "Neo wakes up.",
        },
        {
          tmdbId: 1396,
          mediaType: "tv",
          title: "Breaking Bad",
          year: 2008,
          posterUrl: null,
          overview: "Chemistry teacher goes dark.",
        },
      ],
    });
  });

  it("throws TmdbUpstreamError on a non-2xx response", async () => {
    globalThis.fetch = async () => jsonResponse(503, { status_message: "down" });

    const tmdb = createTmdbClient({ apiKey: "k" });

    await assert.rejects(
      () => tmdb.search("x"),
      (err: unknown) =>
        err instanceof TmdbUpstreamError &&
        err.status === 503 &&
        err.message.includes("503"),
    );
  });
});

describe("mapMediaSummary", () => {
  it("uses the default media type when media_type is absent", () => {
    assert.deepEqual(
      mapMediaSummary(
        {
          id: 42,
          name: "A Similar Show",
          first_air_date: "2024-01-02",
          poster_path: null,
          overview: "Related television.",
        },
        "tv",
      ),
      {
        tmdbId: 42,
        mediaType: "tv",
        title: "A Similar Show",
        year: 2024,
        posterUrl: null,
        overview: "Related television.",
      },
    );
  });
});

describe("createTmdbClient().genres", () => {
  it("maps valid genres and skips malformed rows", async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/3/genre/movie/list");
      return jsonResponse(200, {
        genres: [
          { id: 28, name: "Action" },
          { id: "35", name: "Comedy" },
          { id: 18 },
          null,
          { id: 99, name: "Documentary" },
        ],
      });
    };

    const results = await createTmdbClient({ apiKey: "k" }).genres("movie");

    assert.deepEqual(results, [
      { id: 28, name: "Action" },
      { id: 99, name: "Documentary" },
    ]);
  });
});

describe("createTmdbClient().discover", () => {
  it("maps implied media type, pagination, and optional genre query", async () => {
    const calls: URL[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      return jsonResponse(200, {
        page: Number(url.searchParams.get("page")),
        total_pages: 12,
        results: [
          {
            id: 1396,
            name: "Breaking Bad",
            first_air_date: "2008-01-20",
            poster_path: null,
            overview: "Chemistry teacher goes dark.",
          },
        ],
      });
    };

    const tmdb = createTmdbClient({ apiKey: "k" });
    const withGenre = await tmdb.discover("tv", {
      genreId: 18,
      page: 3,
    });
    await tmdb.discover("tv");

    assert.equal(calls[0].pathname, "/3/discover/tv");
    assert.equal(calls[0].searchParams.get("sort_by"), "popularity.desc");
    assert.equal(calls[0].searchParams.get("include_adult"), "false");
    assert.equal(calls[0].searchParams.get("with_genres"), "18");
    assert.equal(calls[0].searchParams.get("page"), "3");
    assert.equal(calls[1].searchParams.has("with_genres"), false);
    assert.equal(calls[1].searchParams.get("page"), "1");
    assert.deepEqual(withGenre, {
      page: 3,
      totalPages: 12,
      results: [
        {
          tmdbId: 1396,
          mediaType: "tv",
          title: "Breaking Bad",
          year: 2008,
          posterUrl: null,
          overview: "Chemistry teacher goes dark.",
        },
      ],
    });
  });
});

describe("createTmdbClient().recommendations", () => {
  it("maps recommendation media types, excludes the source, and caps at 20", async () => {
    const rows = [
      {
        media_type: "movie",
        id: 603,
        title: "The Matrix",
      },
      ...Array.from({ length: 21 }, (_, index) => ({
        media_type: index === 0 ? "tv" : "movie",
        id: 700 + index,
        ...(index === 0
          ? { name: "Related Show", first_air_date: "2020-01-01" }
          : { title: `Related Movie ${index}`, release_date: "2021-01-01" }),
      })),
    ];
    globalThis.fetch = async (input) => {
      assert.match(String(input), /\/movie\/603\/recommendations\?/);
      return jsonResponse(200, { results: rows, total_pages: 1 });
    };

    const results = await createTmdbClient({ apiKey: "k" }).recommendations(
      "movie",
      603,
    );

    assert.equal(results.length, 20);
    assert.equal(results.some((item) => item.tmdbId === 603), false);
    assert.deepEqual(results[0], {
      tmdbId: 700,
      mediaType: "tv",
      title: "Related Show",
      year: 2020,
      posterUrl: null,
      overview: "",
    });
    assert.equal(results[19].tmdbId, 719);
  });

  it("falls back to similar and supplies its implied media type", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(new URL(url).pathname);
      if (url.includes("/recommendations")) {
        return jsonResponse(200, { results: [], total_pages: 1 });
      }
      return jsonResponse(200, {
        results: [
          { id: 1396, name: "Source" },
          {
            id: 60059,
            name: "Better Call Saul",
            first_air_date: "2015-02-08",
            poster_path: "/bcs.jpg",
            overview: "A lawyer's story.",
          },
        ],
        total_pages: 1,
      });
    };

    const results = await createTmdbClient({ apiKey: "k" }).recommendations(
      "tv",
      1396,
    );

    assert.deepEqual(calls, [
      "/3/tv/1396/recommendations",
      "/3/tv/1396/similar",
    ]);
    assert.deepEqual(results, [
      {
        tmdbId: 60059,
        mediaType: "tv",
        title: "Better Call Saul",
        year: 2015,
        posterUrl: "https://image.tmdb.org/t/p/w500/bcs.jpg",
        overview: "A lawyer's story.",
      },
    ]);
  });
});

describe("createTmdbClient().tvDetail", () => {
  it("maps seasons (excludes season 0) and reads tvdbId from external_ids", async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      assert.match(url, /\/tv\/1396\?/);
      assert.match(url, /append_to_response=external_ids/);
      assert.match(url, /api_key=k/);
      return jsonResponse(200, {
        id: 1396,
        name: "Breaking Bad",
        first_air_date: "2008-01-20",
        overview: "Chemistry teacher goes dark.",
        poster_path: "/bb.jpg",
        backdrop_path: "/bb-bg.jpg",
        status: "Ended",
        genres: [{ id: 18, name: "Drama" }],
        seasons: [
          {
            season_number: 0,
            name: "Specials",
            episode_count: 2,
          },
          {
            season_number: 1,
            name: "Season 1",
            episode_count: 7,
          },
          {
            season_number: 2,
            name: "Season 2",
            episode_count: 13,
          },
        ],
        external_ids: {
          tvdb_id: 81189,
          imdb_id: "tt0903747",
        },
      });
    };

    const tmdb = createTmdbClient({ apiKey: "k" });
    const detail = await tmdb.tvDetail(1396);

    assert.deepEqual(detail, {
      tmdbId: 1396,
      mediaType: "tv",
      title: "Breaking Bad",
      year: 2008,
      overview: "Chemistry teacher goes dark.",
      posterUrl: "https://image.tmdb.org/t/p/w500/bb.jpg",
      backdropUrl: "https://image.tmdb.org/t/p/w500/bb-bg.jpg",
      genres: ["Drama"],
      status: "Ended",
      tvdbId: 81189,
      seasons: [
        { seasonNumber: 1, name: "Season 1", episodeCount: 7 },
        { seasonNumber: 2, name: "Season 2", episodeCount: 13 },
      ],
    });
  });
});
