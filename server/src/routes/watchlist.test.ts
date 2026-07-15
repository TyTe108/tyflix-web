import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import type { SessionPayload } from "../session";
import {
  createWatchlistRouter,
  type WatchlistRouterDeps,
} from "./watchlist";

const session: SessionPayload = {
  seerrUserId: 7,
  plexId: 42,
  plexUsername: "alice",
  displayName: "Alice",
  avatar: null,
  permissions: 0,
  iat: 1,
  exp: 2,
};

describe("watchlist route", () => {
  it("annotates tracked items and uses null for untracked items", async () => {
    const app = createApp({
      seerr: {
        async listUserWatchlist(userId) {
          assert.equal(userId, 7);
          return [
            { tmdbId: 603, mediaType: "movie", title: "The Matrix" },
            { tmdbId: 1396, mediaType: "tv", title: "Breaking Bad" },
          ];
        },
      },
      mediaStatus: {
        async getStatusMap() {
          return new Map([["movie:603", "available" as const]]);
        },
        async getMediaId() {
          return null;
        },
      },
      mediaEnrichment: {
        async enrich(items) {
          assert.deepEqual(items, [
            {
              tmdbId: 603,
              mediaType: "movie",
              title: "The Matrix",
              mediaStatus: "available",
            },
            {
              tmdbId: 1396,
              mediaType: "tv",
              title: "Breaking Bad",
              mediaStatus: null,
            },
          ]);
          return new Map([
            [
              "movie:603",
              {
                title: "TMDB title is not used",
                posterUrl: "https://image.tmdb.org/t/p/w500/matrix.jpg",
              },
            ],
          ]);
        },
      },
    });

    const response = await fetchLocal(app, "/api/watchlist");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      results: [
        {
          tmdbId: 603,
          mediaType: "movie",
          title: "The Matrix",
          mediaStatus: "available",
          posterUrl: "https://image.tmdb.org/t/p/w500/matrix.jpg",
        },
        {
          tmdbId: 1396,
          mediaType: "tv",
          title: "Breaking Bad",
          mediaStatus: null,
          posterUrl: null,
        },
      ],
    });
  });

  it("returns 502 when Seerr's watchlist request fails", async () => {
    const app = createApp({
      seerr: {
        async listUserWatchlist() {
          throw new Error("Seerr unavailable");
        },
      },
      mediaStatus: {
        async getStatusMap() {
          return new Map();
        },
        async getMediaId() {
          return null;
        },
      },
      mediaEnrichment: {
        async enrich() {
          return new Map();
        },
      },
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(app, "/api/watchlist");
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: "Seerr unavailable" });
    } finally {
      console.error = originalConsoleError;
    }
  });
});

function createApp(deps: WatchlistRouterDeps): express.Express {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.session = session;
    next();
  });
  app.use("/api/watchlist", createWatchlistRouter(deps));
  return app;
}

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
