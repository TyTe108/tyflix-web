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

describe("createTmdbClient().upcoming", () => {
  it("uses the media endpoint, supplies the media type, and caps at 20", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      const mediaType = url.pathname.includes("/movie/") ? "movie" : "tv";
      return jsonResponse(200, {
        results: Array.from({ length: 22 }, (_, index) => ({
          id: 100 + index,
          ...(mediaType === "movie"
            ? { title: `Movie ${index}`, release_date: "2026-01-01" }
            : { name: `Show ${index}`, first_air_date: "2026-01-01" }),
          poster_path: index === 0 ? "/poster.jpg" : null,
          overview: "",
        })),
      });
    };

    const tmdb = createTmdbClient({ apiKey: "k" });
    const movies = await tmdb.upcoming("movie");
    const tv = await tmdb.upcoming("tv");

    assert.deepEqual(calls, ["/3/movie/upcoming", "/3/tv/on_the_air"]);
    assert.equal(movies.length, 20);
    assert.equal(tv.length, 20);
    assert.equal(movies[0].mediaType, "movie");
    assert.equal(movies[0].title, "Movie 0");
    assert.equal(tv[0].mediaType, "tv");
    assert.equal(tv[0].title, "Show 0");
    assert.equal(
      tv[0].posterUrl,
      "https://image.tmdb.org/t/p/w500/poster.jpg",
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
    await tmdb.discover("movie", { genreId: 28, companyId: 420 });
    await tmdb.discover("tv", { networkId: 213 });

    assert.equal(calls[0].pathname, "/3/discover/tv");
    assert.equal(calls[0].searchParams.get("sort_by"), "popularity.desc");
    assert.equal(calls[0].searchParams.get("include_adult"), "false");
    assert.equal(calls[0].searchParams.get("with_genres"), "18");
    assert.equal(calls[0].searchParams.get("page"), "3");
    assert.equal(calls[1].searchParams.has("with_genres"), false);
    assert.equal(calls[1].searchParams.has("with_companies"), false);
    assert.equal(calls[1].searchParams.has("with_networks"), false);
    assert.equal(calls[1].searchParams.get("page"), "1");
    assert.equal(calls[2].pathname, "/3/discover/movie");
    assert.equal(calls[2].searchParams.get("with_genres"), "28");
    assert.equal(calls[2].searchParams.get("with_companies"), "420");
    assert.equal(calls[2].searchParams.has("with_networks"), false);
    assert.equal(calls[3].pathname, "/3/discover/tv");
    assert.equal(calls[3].searchParams.get("with_networks"), "213");
    assert.equal(calls[3].searchParams.has("with_companies"), false);
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

describe("createTmdbClient().credits", () => {
  it("maps and caps ordered cast and key, deduplicated crew", async () => {
    const cast = Array.from({ length: 20 }, (_, index) => ({
      id: 100 + index,
      name: `Actor ${index}`,
      character: `Character ${index}`,
      profile_path: index === 19 ? null : `/actor-${index}.jpg`,
      order: 19 - index,
    }));
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/3/tv/95396/credits");
      assert.equal(url.searchParams.get("api_key"), "k");
      return jsonResponse(200, {
        cast: [
          ...cast,
          { id: "bad", name: "Malformed", order: -1 },
          { id: 999, order: -2 },
        ],
        crew: [
          {
            id: 1,
            name: "Alex Creator",
            job: "Creator",
            profile_path: "/alex.jpg",
          },
          {
            id: 1,
            name: "Alex Creator",
            job: "Executive Producer",
            profile_path: "/alex.jpg",
          },
          { id: 2, name: "A Director", job: "Director", profile_path: null },
          { id: 3, name: "A Composer", job: "Original Music Composer" },
          { id: "bad", name: "Malformed", job: "Writer" },
          ...Array.from({ length: 7 }, (_, index) => ({
            id: 10 + index,
            name: `Writer ${index}`,
            job: "Writer",
            profile_path: null,
          })),
        ],
      });
    };

    const result = await createTmdbClient({ apiKey: "k" }).credits("tv", 95396);

    assert.equal(result.cast.length, 18);
    assert.deepEqual(result.cast[0], {
      id: 119,
      name: "Actor 19",
      character: "Character 19",
      profileUrl: null,
    });
    assert.equal(
      result.cast[1].profileUrl,
      "https://image.tmdb.org/t/p/w500/actor-18.jpg",
    );
    assert.deepEqual(result.cast[17], {
      id: 102,
      name: "Actor 2",
      character: "Character 2",
      profileUrl: "https://image.tmdb.org/t/p/w500/actor-2.jpg",
    });
    assert.equal(result.crew.length, 8);
    assert.deepEqual(result.crew[0], {
      id: 1,
      name: "Alex Creator",
      job: "Creator / Executive Producer",
      profileUrl: "https://image.tmdb.org/t/p/w500/alex.jpg",
    });
    assert.deepEqual(result.crew[1], {
      id: 2,
      name: "A Director",
      job: "Director",
      profileUrl: null,
    });
    assert.equal(result.crew.some((person) => person.name === "A Composer"), false);
    assert.equal(result.crew[result.crew.length - 1].name, "Writer 5");
  });
});

describe("createTmdbClient().person", () => {
  it("maps person fields and handles missing profile paths", async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("api_key"), "k");
      if (url.pathname === "/3/person/3") {
        return jsonResponse(200, {
          id: 3,
          name: "Harrison Ford",
          biography: "An American actor.",
          birthday: "1942-07-13",
          place_of_birth: "Chicago, Illinois, USA",
          known_for_department: "Acting",
          profile_path: "/ford.jpg",
        });
      }
      assert.equal(url.pathname, "/3/person/4");
      return jsonResponse(200, {
        id: 4,
        name: "No Photo",
        biography: null,
        birthday: null,
        place_of_birth: null,
        known_for_department: "Directing",
        profile_path: null,
      });
    };

    const tmdb = createTmdbClient({ apiKey: "k" });

    assert.deepEqual(await tmdb.person(3), {
      id: 3,
      name: "Harrison Ford",
      biography: "An American actor.",
      profileUrl: "https://image.tmdb.org/t/p/w500/ford.jpg",
      knownForDepartment: "Acting",
      birthday: "1942-07-13",
      placeOfBirth: "Chicago, Illinois, USA",
    });
    assert.deepEqual(await tmdb.person(4), {
      id: 4,
      name: "No Photo",
      biography: "",
      profileUrl: null,
      knownForDepartment: "Directing",
      birthday: null,
      placeOfBirth: null,
    });
  });
});

describe("createTmdbClient().personCredits", () => {
  it("maps, deduplicates, filters Self roles, sorts, and caps at 24", async () => {
    const movies = Array.from({ length: 26 }, (_, index) => ({
      id: 100 + index,
      media_type: "movie",
      title: `Movie ${index}`,
      release_date: "2000-01-01",
      poster_path: index === 1 ? "/movie.jpg" : null,
      overview: "",
      character: "A character",
      popularity: 26 - index,
    }));
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/3/person/3/combined_credits");
      return jsonResponse(200, {
        cast: [
          ...movies,
          {
            ...movies[0],
            title: "Most Popular Version",
            popularity: 200,
          },
          {
            id: 500,
            media_type: "tv",
            name: "Popular Show",
            first_air_date: "2022-01-01",
            character: "Lead",
            popularity: 100,
          },
          {
            id: 900,
            media_type: "tv",
            name: "Talk Show",
            character: "Self",
            popularity: 999,
          },
          {
            id: 901,
            media_type: "tv",
            name: "Interview",
            character: "Self - Guest",
            popularity: 998,
          },
          { id: 902, media_type: "person", popularity: 997 },
        ],
      });
    };

    const results = await createTmdbClient({ apiKey: "k" }).personCredits(3);

    assert.equal(results.length, 24);
    assert.deepEqual(results[0], {
      tmdbId: 100,
      mediaType: "movie",
      title: "Most Popular Version",
      year: 2000,
      posterUrl: null,
      overview: "",
    });
    assert.deepEqual(results[1], {
      tmdbId: 500,
      mediaType: "tv",
      title: "Popular Show",
      year: 2022,
      posterUrl: null,
      overview: "",
    });
    assert.equal(results[2].posterUrl, "https://image.tmdb.org/t/p/w500/movie.jpg");
    assert.equal(results[results.length - 1].tmdbId, 122);
    assert.equal(results.some((item) => item.tmdbId === 900), false);
    assert.equal(
      results.filter((item) => item.mediaType === "movie" && item.tmdbId === 100)
        .length,
      1,
    );
  });
});

describe("createTmdbClient().collection", () => {
  it("maps collection images and chronologically sorted valid parts", async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/3/collection/2344");
      return jsonResponse(200, {
        id: 2344,
        name: "The Matrix Collection",
        overview: "A science-fiction franchise.",
        poster_path: "/collection.jpg",
        backdrop_path: "/collection-bg.jpg",
        parts: [
          {
            id: 605,
            media_type: "movie",
            title: "The Matrix Revolutions",
            release_date: "2003-11-05",
            poster_path: "/revolutions.jpg",
          },
          { id: "bad", media_type: "movie", title: "Malformed" },
          {
            id: 603,
            media_type: "movie",
            title: "The Matrix",
            release_date: "1999-03-31",
            poster_path: "/matrix.jpg",
          },
          {
            id: 604,
            title: "The Matrix Reloaded",
            release_date: "2003-05-15",
            poster_path: null,
          },
          {
            id: 624860,
            media_type: "movie",
            title: "The Matrix Resurrections",
            release_date: "",
          },
        ],
      });
    };

    const result = await createTmdbClient({ apiKey: "k" }).collection(2344);

    assert.equal(result.id, 2344);
    assert.equal(result.name, "The Matrix Collection");
    assert.equal(result.overview, "A science-fiction franchise.");
    assert.equal(
      result.posterUrl,
      "https://image.tmdb.org/t/p/w500/collection.jpg",
    );
    assert.equal(
      result.backdropUrl,
      "https://image.tmdb.org/t/p/w500/collection-bg.jpg",
    );
    assert.deepEqual(
      result.parts.map((part) => part.tmdbId),
      [603, 604, 605, 624860],
    );
    assert.equal(result.parts[1].mediaType, "movie");
    assert.equal(result.parts[1].posterUrl, null);
  });
});

describe("createTmdbClient().movieDetail", () => {
  it("maps present and absent collection data", async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("append_to_response"), "external_ids");
      const id = Number(url.pathname.split("/").pop());
      return jsonResponse(200, {
        id,
        title: id === 78 ? "Blade Runner" : "Standalone Movie",
        release_date: "1982-06-25",
        overview: "",
        poster_path: null,
        backdrop_path: null,
        runtime: 118,
        genres: [],
        status: "Released",
        belongs_to_collection:
          id === 78
            ? { id: 422837, name: "Blade Runner Collection" }
            : null,
      });
    };

    const tmdb = createTmdbClient({ apiKey: "k" });
    const inCollection = await tmdb.movieDetail(78);
    const standalone = await tmdb.movieDetail(1);

    assert.deepEqual(inCollection.collection, {
      id: 422837,
      name: "Blade Runner Collection",
    });
    assert.equal(standalone.collection, null);
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
