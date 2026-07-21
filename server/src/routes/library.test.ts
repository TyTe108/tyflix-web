import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import { requireAuth } from "../middleware/auth";
import type { LibrarySortKey, PlexServerClient } from "../plex/server";
import { PlexServerUpstreamError } from "../plex/server";
import { issueSession, SESSION_COOKIE_NAME } from "../session";
import { createLibraryRouter } from "./library";

const SECRET = "sixteen-chars!!!";

function sessionCookie(): string {
  const cookies: Array<{ name: string; value: string }> = [];
  const res = {
    cookies,
    cookie(name: string, value: string) {
      cookies.push({ name, value });
    },
  };
  issueSession(
    res as unknown as import("express").Response,
    {
      seerrUserId: 1,
      plexId: 10,
      plexUsername: "tyler",
      displayName: "Tyler",
      avatar: null,
      permissions: 0,
    },
    { secret: SECRET, secure: false },
  );
  return `${SESSION_COOKIE_NAME}=${cookies[0].value}`;
}

function createApp(plexServer: PlexServerClient): express.Express {
  const app = express();
  app.use(
    "/api/library",
    requireAuth(SECRET),
    createLibraryRouter({ plexServer }),
  );
  return app;
}

describe("library routes", () => {
  it("GET /sections returns movie and show sections", async () => {
    const app = createApp({
      async sections() {
        return [{ key: "1", title: "Movies", type: "movie" }];
      },
    } as unknown as PlexServerClient);

    const response = await fetchLocal(
      app,
      "/api/library/sections",
      sessionCookie(),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sections: [{ key: "1", title: "Movies", type: "movie" }],
    });
  });

  it("GET /sections/:key/items validates params and returns paged items", async () => {
    const calls: Array<{
      sectionKey: string;
      sort: string;
      start: number;
      size: number;
    }> = [];
    const app = createApp({
      async sections() {
        return [];
      },
      async sectionItems(options: {
        sectionKey: string;
        sort: LibrarySortKey;
        start: number;
        size: number;
      }) {
        calls.push(options);
        return {
          items: [
            {
              ratingKey: "42",
              type: "movie",
              title: "Test",
              year: 2020,
              thumb: null,
              addedAt: null,
              tmdbId: 99,
            },
          ],
          totalSize: 1,
        };
      },
    } as unknown as PlexServerClient);

    const response = await fetchLocal(
      app,
      "/api/library/sections/1/items?sort=year&start=10&size=20",
      sessionCookie(),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      { sectionKey: "1", sort: "year", start: 10, size: 20 },
    ]);
    assert.deepEqual(await response.json(), {
      items: [
        {
          ratingKey: "42",
          type: "movie",
          title: "Test",
          year: 2020,
          thumb: null,
          addedAt: null,
          tmdbId: 99,
        },
      ],
      totalSize: 1,
      start: 10,
      size: 20,
      sort: "year",
    });
  });

  it("GET /sections/:key/items uses defaults for optional query params", async () => {
    const calls: Array<{
      sectionKey: string;
      sort: string;
      start: number;
      size: number;
    }> = [];
    const app = createApp({
      async sections() {
        return [];
      },
      async sectionItems(options: {
        sectionKey: string;
        sort: LibrarySortKey;
        start: number;
        size: number;
      }) {
        calls.push(options);
        return { items: [], totalSize: 0 };
      },
    } as unknown as PlexServerClient);

    const response = await fetchLocal(
      app,
      "/api/library/sections/3/items",
      sessionCookie(),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      { sectionKey: "3", sort: "title", start: 0, size: 50 },
    ]);
    assert.deepEqual(await response.json(), {
      items: [],
      totalSize: 0,
      start: 0,
      size: 50,
      sort: "title",
    });
  });

  it("returns 400 for invalid section key, sort, start, and size", async () => {
    const app = createApp({
      async sections() {
        return [];
      },
      async sectionItems() {
        throw new Error("should not be called");
      },
    } as unknown as PlexServerClient);
    const cookie = sessionCookie();

    const badKey = await fetchLocal(
      app,
      "/api/library/sections/abc/items",
      cookie,
    );
    assert.equal(badKey.status, 400);
    assert.deepEqual(await badKey.json(), { error: "invalid section key" });

    const badSort = await fetchLocal(
      app,
      "/api/library/sections/1/items?sort=foo",
      cookie,
    );
    assert.equal(badSort.status, 400);
    assert.deepEqual(await badSort.json(), { error: "invalid sort" });

    const badStart = await fetchLocal(
      app,
      "/api/library/sections/1/items?start=-1",
      cookie,
    );
    assert.equal(badStart.status, 400);
    assert.deepEqual(await badStart.json(), { error: "invalid start" });

    const badSize = await fetchLocal(
      app,
      "/api/library/sections/1/items?size=0",
      cookie,
    );
    assert.equal(badSize.status, 400);
    assert.deepEqual(await badSize.json(), { error: "invalid size" });

    const sizeTooLarge = await fetchLocal(
      app,
      "/api/library/sections/1/items?size=101",
      cookie,
    );
    assert.equal(sizeTooLarge.status, 400);
    assert.deepEqual(await sizeTooLarge.json(), { error: "invalid size" });
  });

  it("returns 502 when Plex upstream fails", async () => {
    const app = createApp({
      async sections() {
        throw new PlexServerUpstreamError("Plex blew up", 503);
      },
    } as unknown as PlexServerClient);

    const response = await fetchLocal(
      app,
      "/api/library/sections",
      sessionCookie(),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Plex blew up" });
  });
});

async function fetchLocal(
  app: express.Express,
  path: string,
  cookie: string,
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: { Cookie: cookie },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
