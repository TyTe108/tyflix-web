import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import {
  annotateMediaStatus,
  createDiscoverRouter,
  type DiscoverRouterDeps,
} from "./discover";
import { createMediaStatusProvider } from "../seerr/mediaStatusProvider";

function createStubTmdb(): DiscoverRouterDeps["tmdb"] {
  return {
    async search(_query, page) {
      return {
        page: page ?? 1,
        totalPages: 1,
        results: [
          {
            tmdbId: 1396,
            mediaType: "tv",
            title: "Breaking Bad",
            year: 2008,
            posterUrl: null,
            overview: "",
          },
        ],
      };
    },
    async trending() {
      return [
        {
          tmdbId: 603,
          mediaType: "movie",
          title: "The Matrix",
          year: 1999,
          posterUrl: null,
          overview: "",
        },
        {
          tmdbId: 603,
          mediaType: "tv",
          title: "Different media type",
          year: null,
          posterUrl: null,
          overview: "",
        },
      ];
    },
    async recommendations(_mediaType, _id) {
      return [
        {
          tmdbId: 603,
          mediaType: "movie",
          title: "The Matrix",
          year: 1999,
          posterUrl: null,
          overview: "",
        },
        {
          tmdbId: 60059,
          mediaType: "tv",
          title: "Better Call Saul",
          year: 2015,
          posterUrl: null,
          overview: "",
        },
      ];
    },
    async movieDetail(id) {
      return {
        tmdbId: id,
        mediaType: "movie",
        title: "The Matrix",
        year: 1999,
        overview: "",
        posterUrl: null,
        backdropUrl: null,
        runtime: 136,
        genres: [],
        status: "Released",
      };
    },
    async tvDetail(id) {
      return {
        tmdbId: id,
        mediaType: "tv",
        title: "Breaking Bad",
        year: 2008,
        overview: "",
        posterUrl: null,
        backdropUrl: null,
        genres: [],
        status: "Ended",
        tvdbId: 81189,
        seasons: [],
      };
    },
  };
}

function createApp(deps: DiscoverRouterDeps): express.Express {
  const app = express();
  app.use("/api/discover", createDiscoverRouter(deps));
  return app;
}

describe("discovery media status annotation", () => {
  it("matches by both TMDB id and media type and otherwise uses null", () => {
    const statuses = new Map([
      ["movie:603", "available" as const],
    ]);

    assert.equal(
      annotateMediaStatus(
        { tmdbId: 603, mediaType: "movie" as const },
        statuses,
      ).mediaStatus,
      "available",
    );
    assert.equal(
      annotateMediaStatus(
        { tmdbId: 603, mediaType: "tv" as const },
        statuses,
      ).mediaStatus,
      null,
    );
  });

  it("annotates trending, search, movie detail, and TV detail responses", async () => {
    let mediaCalls = 0;
    const app = createApp({
      tmdb: createStubTmdb(),
      mediaStatus: createMediaStatusProvider({
        async listMedia() {
          mediaCalls += 1;
          return [
            { id: 10, tmdbId: 603, mediaType: "movie", status: 5 },
            { id: 20, tmdbId: 1396, mediaType: "tv", status: 4 },
          ];
        },
      }),
    });

    const trending = await fetchLocal(app, "/api/discover/trending");
    const search = await fetchLocal(
      app,
      "/api/discover/search?query=breaking+bad&page=2",
    );
    const movie = await fetchLocal(app, "/api/discover/movie/603");
    const tv = await fetchLocal(app, "/api/discover/tv/1396");
    const recommendations = await fetchLocal(
      app,
      "/api/discover/tv/1396/recommendations",
    );

    assert.equal(trending.status, 200);
    assert.deepEqual(
      ((await trending.json()) as { results: Array<{ mediaStatus: unknown }> })
        .results.map((item) => item.mediaStatus),
      ["available", null],
    );
    assert.equal(
      (
        (await search.json()) as {
          results: Array<{ mediaStatus: unknown }>;
        }
      ).results[0].mediaStatus,
      "partially_available",
    );
    assert.equal(
      ((await movie.json()) as { mediaStatus: unknown }).mediaStatus,
      "available",
    );
    assert.equal(
      ((await tv.json()) as { mediaStatus: unknown }).mediaStatus,
      "partially_available",
    );
    assert.deepEqual(
      (
        (await recommendations.json()) as {
          results: Array<{ mediaStatus: unknown }>;
        }
      ).results.map((item) => item.mediaStatus),
      ["available", null],
    );
    assert.equal(mediaCalls, 1);
  });

  it("still returns discovery results with null status when Seerr fails", async () => {
    const app = createApp({
      tmdb: createStubTmdb(),
      mediaStatus: createMediaStatusProvider({
        async listMedia() {
          throw new Error("Seerr unavailable");
        },
      }),
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(app, "/api/discover/trending");
      const body = (await response.json()) as {
        results: Array<{ mediaStatus: unknown }>;
      };

      assert.equal(response.status, 200);
      assert.deepEqual(
        body.results.map((item) => item.mediaStatus),
        [null, null],
      );
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe("GET /api/discover/:mediaType/:id/recommendations", () => {
  it("returns null statuses when the media status provider rejects", async () => {
    const app = createApp({
      tmdb: createStubTmdb(),
      mediaStatus: {
        async getStatusMap() {
          throw new Error("Seerr unavailable");
        },
        async getMediaId() {
          return null;
        },
      },
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(
        app,
        "/api/discover/movie/603/recommendations",
      );
      const body = (await response.json()) as {
        results: Array<{ mediaStatus: unknown }>;
      };

      assert.equal(response.status, 200);
      assert.deepEqual(
        body.results.map((item) => item.mediaStatus),
        [null, null],
      );
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("returns 502 when TMDB fails", async () => {
    const tmdb = createStubTmdb();
    tmdb.recommendations = async () => {
      throw new Error("TMDB unavailable");
    };
    const app = createApp({
      tmdb,
      mediaStatus: createMediaStatusProvider({
        async listMedia() {
          return [];
        },
      }),
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(
        app,
        "/api/discover/tv/1396/recommendations",
      );

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: "TMDB unavailable" });
    } finally {
      console.error = originalConsoleError;
    }
  });
});

async function fetchLocal(
  app: express.Express,
  path: string,
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    return await fetch(`http://127.0.0.1:${address.port}${path}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
