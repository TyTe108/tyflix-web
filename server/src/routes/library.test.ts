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
      genre?: string;
      unwatched?: boolean;
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
        genre?: string;
        unwatched?: boolean;
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
      genre: null,
      unwatched: false,
    });
  });

  it("GET /sections/:key/items passes genre and unwatched through to sectionItems", async () => {
    const calls: Array<{
      sectionKey: string;
      sort: string;
      start: number;
      size: number;
      genre?: string;
      unwatched?: boolean;
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
        genre?: string;
        unwatched?: boolean;
      }) {
        calls.push(options);
        return { items: [], totalSize: 0 };
      },
    } as unknown as PlexServerClient);

    const response = await fetchLocal(
      app,
      "/api/library/sections/1/items?genre=1131&unwatched=true",
      sessionCookie(),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      {
        sectionKey: "1",
        sort: "title",
        start: 0,
        size: 50,
        genre: "1131",
        unwatched: true,
      },
    ]);
    assert.deepEqual(await response.json(), {
      items: [],
      totalSize: 0,
      start: 0,
      size: 50,
      sort: "title",
      genre: "1131",
      unwatched: true,
    });
  });

  it("GET /sections/:key/items rejects invalid genre and unwatched with 400", async () => {
    const app = createApp({
      async sections() {
        return [];
      },
      async sectionItems() {
        throw new Error("should not be called");
      },
    } as unknown as PlexServerClient);
    const cookie = sessionCookie();

    const badGenre = await fetchLocal(
      app,
      "/api/library/sections/1/items?genre=action",
      cookie,
    );
    assert.equal(badGenre.status, 400);
    assert.deepEqual(await badGenre.json(), { error: "invalid genre" });

    const badUnwatched = await fetchLocal(
      app,
      "/api/library/sections/1/items?unwatched=maybe",
      cookie,
    );
    assert.equal(badUnwatched.status, 400);
    assert.deepEqual(await badUnwatched.json(), { error: "invalid unwatched" });
  });

  it("GET /sections/:key/genres returns the genre list", async () => {
    const app = createApp({
      async sectionGenres(sectionKey: string) {
        assert.equal(sectionKey, "1");
        return [
          { id: "1131", title: "Action" },
          { id: "18", title: "Drama" },
        ];
      },
    } as unknown as PlexServerClient);

    const response = await fetchLocal(
      app,
      "/api/library/sections/1/genres",
      sessionCookie(),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      genres: [
        { id: "1131", title: "Action" },
        { id: "18", title: "Drama" },
      ],
    });
  });

  it("GET /sections/:key/genres rejects a non-numeric section key with 400", async () => {
    const app = createApp({
      async sectionGenres() {
        throw new Error("should not be called");
      },
    } as unknown as PlexServerClient);

    const response = await fetchLocal(
      app,
      "/api/library/sections/abc/genres",
      sessionCookie(),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid section key" });
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
      genre: null,
      unwatched: false,
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

  it("GET /image proxies a whitelisted thumb path", async () => {
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    let fetchedPath: string | null = null;
    const app = createApp({
      async fetchImage(path: string) {
        fetchedPath = path;
        return {
          ok: true,
          status: 200,
          contentType: "image/jpeg",
          body: imageBytes,
        };
      },
    } as unknown as PlexServerClient);

    const thumbPath = "/library/metadata/3613/thumb/1780131692";
    const response = await fetchLocal(
      app,
      `/api/library/image?path=${encodeURIComponent(thumbPath)}`,
      sessionCookie(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=86400",
    );
    assert.equal(fetchedPath, thumbPath);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), imageBytes);
  });

  it("GET /image rejects missing and non-whitelisted paths without calling fetchImage", async () => {
    let fetchCalls = 0;
    const app = createApp({
      async fetchImage() {
        fetchCalls += 1;
        throw new Error("fetchImage should not be called");
      },
    } as unknown as PlexServerClient);
    const cookie = sessionCookie();

    const missing = await fetchLocal(app, "/api/library/image", cookie);
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "path is required" });

    const badPaths = [
      "/library/sections/1/all",
      "/etc/passwd",
      "https://evil.example/thumb",
      "/library/metadata/1/thumb/2?foo=bar",
      "/library/metadata/1/thumb/2/../../../etc/passwd",
      "//evil.example/library/metadata/1/thumb/2",
    ];
    for (const badPath of badPaths) {
      const response = await fetchLocal(
        app,
        `/api/library/image?path=${encodeURIComponent(badPath)}`,
        cookie,
      );
      assert.equal(response.status, 400, `expected 400 for ${badPath}`);
      assert.deepEqual(await response.json(), { error: "invalid image path" });
    }

    assert.equal(fetchCalls, 0);
  });

  it("GET /image returns 502 when upstream image fetch is not ok", async () => {
    const app = createApp({
      async fetchImage() {
        return {
          ok: false,
          status: 404,
          contentType: null,
          body: Buffer.alloc(0),
        };
      },
    } as unknown as PlexServerClient);

    const response = await fetchLocal(
      app,
      "/api/library/image?path=%2Flibrary%2Fmetadata%2F3613%2Fthumb%2F1780131692",
      sessionCookie(),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "image fetch failed" });
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
