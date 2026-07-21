import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createPlexServerClient,
  PlexServerUpstreamError,
} from "./server";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BASE_URL = "http://10.0.0.10:32400";
const TOKEN = "owner-token";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client() {
  return createPlexServerClient({ baseUrl: BASE_URL, token: TOKEN });
}

describe("plexServer.episodes", () => {
  it("parses allLeaves into a sorted PlexEpisode[], skipping malformed leaves", async () => {
    let requestedUrl: string | null = null;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return jsonResponse(200, {
        MediaContainer: {
          Metadata: [
            // Out of order on purpose to prove sorting.
            {
              ratingKey: 202,
              parentIndex: 1,
              index: 2,
              title: "Second",
              // No thumb — must still parse, with thumb: null.
            },
            {
              ratingKey: 301,
              parentIndex: 2,
              index: 1,
              title: "Season Two Opener",
              thumb: "/library/metadata/301/thumb/99",
            },
            {
              ratingKey: 201,
              parentIndex: 1,
              index: 1,
              title: "Pilot",
              thumb: "/library/metadata/201/thumb/1781154351",
            },
            // Malformed: missing ratingKey — dropped.
            { parentIndex: 1, index: 3, title: "No Key" },
            // Malformed: non-numeric episode index — dropped.
            {
              ratingKey: 210,
              parentIndex: 1,
              index: "oops",
              title: "Bad Index",
            },
            // Malformed: non-numeric season — dropped.
            {
              ratingKey: 211,
              parentIndex: null,
              index: 4,
              title: "Bad Season",
            },
          ],
        },
      });
    }) as typeof fetch;

    const episodes = await client().episodes("9000");

    assert.equal(
      requestedUrl,
      `${BASE_URL}/library/metadata/9000/allLeaves`,
    );
    assert.deepEqual(episodes, [
      {
        ratingKey: "201",
        seasonNumber: 1,
        episodeNumber: 1,
        title: "Pilot",
        thumb: "/library/metadata/201/thumb/1781154351",
      },
      {
        ratingKey: "202",
        seasonNumber: 1,
        episodeNumber: 2,
        title: "Second",
        thumb: null,
      },
      {
        ratingKey: "301",
        seasonNumber: 2,
        episodeNumber: 1,
        title: "Season Two Opener",
        thumb: "/library/metadata/301/thumb/99",
      },
    ]);
  });

  it("defaults a missing title to an empty string", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        MediaContainer: {
          Metadata: [{ ratingKey: 500, parentIndex: 1, index: 1 }],
        },
      })) as typeof fetch;

    const episodes = await client().episodes("9000");

    assert.deepEqual(episodes, [
      {
        ratingKey: "500",
        seasonNumber: 1,
        episodeNumber: 1,
        title: "",
        thumb: null,
      },
    ]);
  });

  it("throws a 502 PlexServerUpstreamError when Plex fails", async () => {
    globalThis.fetch = (async () => jsonResponse(503, {})) as typeof fetch;

    await assert.rejects(client().episodes("9000"), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { status?: number }).status, 503);
      return true;
    });
  });
});

describe("plexServer.nextEpisode", () => {
  const leaves = {
    MediaContainer: {
      Metadata: [
        {
          ratingKey: 201,
          parentIndex: 1,
          index: 1,
          title: "Pilot",
        },
        {
          ratingKey: 202,
          parentIndex: 1,
          index: 2,
          title: "Second",
        },
        {
          ratingKey: 203,
          parentIndex: 1,
          index: 3,
          title: "Finale",
        },
      ],
    },
  };

  it("returns the following episode for a middle episode", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url === `${BASE_URL}/library/metadata/202`) {
        return jsonResponse(200, {
          MediaContainer: {
            Metadata: [{ grandparentRatingKey: 9000 }],
          },
        });
      }
      if (url === `${BASE_URL}/library/metadata/9000/allLeaves`) {
        return jsonResponse(200, leaves);
      }
      return jsonResponse(404, {});
    }) as typeof fetch;

    const next = await client().nextEpisode("202");

    assert.deepEqual(next, {
      ratingKey: "203",
      seasonNumber: 1,
      episodeNumber: 3,
      title: "Finale",
      thumb: null,
    });
  });

  it("returns null for the last episode", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url === `${BASE_URL}/library/metadata/203`) {
        return jsonResponse(200, {
          MediaContainer: {
            Metadata: [{ grandparentRatingKey: 9000 }],
          },
        });
      }
      if (url === `${BASE_URL}/library/metadata/9000/allLeaves`) {
        return jsonResponse(200, leaves);
      }
      return jsonResponse(404, {});
    }) as typeof fetch;

    assert.equal(await client().nextEpisode("203"), null);
  });

  it("returns null when grandparentRatingKey is absent", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        MediaContainer: {
          Metadata: [{ title: "Orphan Episode" }],
        },
      })) as typeof fetch;

    assert.equal(await client().nextEpisode("202"), null);
  });
});

describe("plexServer.playbackMeta", () => {
  it("parses duration and streams from mediaIndex=0/partIndex=0 only", async () => {
    let requestedUrl: string | null = null;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return jsonResponse(200, {
        MediaContainer: {
          Metadata: [
            {
              duration: 5_400_000,
              Media: [
                {
                  Part: [
                    {
                      id: 55501,
                      Stream: [
                        {
                          id: 100,
                          streamType: 1,
                          codec: "h264",
                        },
                        {
                          id: 101,
                          streamType: 2,
                          language: "English",
                          codec: "aac",
                          channels: 2,
                          title: "Stereo",
                          default: 1,
                        },
                        {
                          id: 102,
                          streamType: 3,
                          language: "English",
                          codec: "srt",
                          title: "English SDH",
                          key: "/library/streams/102",
                          forced: 0,
                        },
                        {
                          id: 103,
                          streamType: 3,
                          language: "French",
                          codec: "pgs",
                          title: "Forced FR",
                          forced: 1,
                        },
                      ],
                    },
                    // Second Part — ignored (partIndex=0 only).
                    {
                      Stream: [
                        {
                          id: 999,
                          streamType: 2,
                          language: "Ignored Part",
                          codec: "ac3",
                          channels: 6,
                          default: 1,
                        },
                      ],
                    },
                  ],
                },
                // Second Media — ignored (mediaIndex=0 only).
                {
                  Part: [
                    {
                      Stream: [
                        {
                          id: 888,
                          streamType: 2,
                          language: "Ignored Media",
                          codec: "dts",
                          channels: 8,
                          default: 1,
                        },
                        {
                          id: 889,
                          streamType: 3,
                          language: "Ignored Sub",
                          codec: "ass",
                          key: "/library/streams/889",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
    }) as typeof fetch;

    const meta = await client().playbackMeta("12345");

    assert.equal(
      requestedUrl,
      `${BASE_URL}/library/metadata/12345?includeMarkers=1`,
    );
    assert.equal(meta.durationMs, 5_400_000);
    assert.equal(meta.creditsOffsetMs, null);
    assert.equal(meta.partId, "55501");
    assert.deepEqual(meta.audio, [
      {
        id: "101",
        language: "English",
        codec: "aac",
        channels: 2,
        title: "Stereo",
        default: true,
      },
    ]);
    assert.deepEqual(meta.subtitle, [
      {
        id: "102",
        language: "English",
        codec: "srt",
        title: "English SDH",
        forced: false,
        external: true,
        textBased: true,
      },
      {
        id: "103",
        language: "French",
        codec: "pgs",
        title: "Forced FR",
        forced: true,
        external: false,
        textBased: false,
      },
    ]);
  });

  it("returns empty stream lists when Media or Part is missing", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        MediaContainer: {
          Metadata: [{ duration: 1_000, Media: [] }],
        },
      })) as typeof fetch;

    const meta = await client().playbackMeta("12345");
    assert.equal(meta.durationMs, 1_000);
    assert.equal(meta.creditsOffsetMs, null);
    assert.equal(meta.partId, null);
    assert.deepEqual(meta.audio, []);
    assert.deepEqual(meta.subtitle, []);
  });

  it("parses creditsOffsetMs, preferring a final credits marker", async () => {
    let requestedUrl: string | null = null;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return jsonResponse(200, {
        MediaContainer: {
          Metadata: [
            {
              duration: 2_400_000,
              Marker: [
                {
                  type: "intro",
                  startTimeOffset: 90_000,
                  endTimeOffset: 120_000,
                  final: false,
                  id: 1,
                },
                {
                  type: "credits",
                  startTimeOffset: 2_100_000,
                  endTimeOffset: 2_200_000,
                  final: false,
                  id: 2,
                },
                {
                  type: "credits",
                  startTimeOffset: 2_250_000,
                  endTimeOffset: 2_400_000,
                  final: true,
                  id: 3,
                },
                // Malformed credits offset — ignored.
                {
                  type: "credits",
                  startTimeOffset: "oops",
                  endTimeOffset: 2_400_000,
                  final: true,
                  id: 4,
                },
              ],
            },
          ],
        },
      });
    }) as typeof fetch;

    const meta = await client().playbackMeta("12345");

    assert.equal(
      requestedUrl,
      `${BASE_URL}/library/metadata/12345?includeMarkers=1`,
    );
    assert.equal(meta.creditsOffsetMs, 2_250_000);
    assert.equal(meta.durationMs, 2_400_000);
  });

  it("uses the latest credits marker when none is final", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        MediaContainer: {
          Metadata: [
            {
              duration: 1_800_000,
              Marker: [
                {
                  type: "credits",
                  startTimeOffset: 1_500_000,
                  endTimeOffset: 1_600_000,
                  final: false,
                  id: 1,
                },
                {
                  type: "credits",
                  startTimeOffset: 1_700_000,
                  endTimeOffset: 1_800_000,
                  final: 0,
                  id: 2,
                },
              ],
            },
          ],
        },
      })) as typeof fetch;

    const meta = await client().playbackMeta("12345");
    assert.equal(meta.creditsOffsetMs, 1_700_000);
  });

  it("throws PlexServerUpstreamError when MediaContainer has no metadata", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { MediaContainer: {} })) as typeof fetch;

    await assert.rejects(
      client().playbackMeta("12345"),
      (err: unknown) => {
        assert.ok(err instanceof PlexServerUpstreamError);
        assert.equal(err.status, 502);
        return true;
      },
    );
  });
});

describe("plexServer.selectSubtitle", () => {
  it("PUTs the part-selection URL with the user token", async () => {
    let requestedUrl: string | null = null;
    let requestedMethod: string | null = null;
    let requestedToken: string | null = null;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      requestedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      requestedMethod = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requestedToken = headers.get("X-Plex-Token");
      return jsonResponse(200, {});
    }) as typeof fetch;

    await client().selectSubtitle("55501", "102", "user-token-abc");

    assert.equal(
      requestedUrl,
      `${BASE_URL}/library/parts/55501?subtitleStreamID=102`,
    );
    assert.equal(requestedMethod, "PUT");
    assert.equal(requestedToken, "user-token-abc");
  });

  it("accepts subtitleStreamID 0 to clear the selection", async () => {
    let requestedUrl: string | null = null;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return jsonResponse(200, {});
    }) as typeof fetch;

    await client().selectSubtitle("55501", "0", "user-token-abc");

    assert.equal(
      requestedUrl,
      `${BASE_URL}/library/parts/55501?subtitleStreamID=0`,
    );
  });

  it("throws PlexServerUpstreamError on a non-OK response", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(500, { error: "boom" })) as typeof fetch;

    await assert.rejects(
      client().selectSubtitle("55501", "102", "user-token-abc"),
      (err: unknown) => {
        assert.ok(err instanceof PlexServerUpstreamError);
        assert.equal(err.status, 500);
        assert.match(err.message, /\/library\/parts\/55501/);
        return true;
      },
    );
  });
});

describe("plexServer.sections", () => {
  it("returns movie and show sections, skipping other types and malformed rows", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      assert.equal(url, `${BASE_URL}/library/sections`);
      return jsonResponse(200, {
        MediaContainer: {
          Directory: [
            { key: 1, title: "Movies", type: "movie" },
            { key: 2, title: "TV Shows", type: "show" },
            { key: 3, title: "Music", type: "artist" },
            { key: 4, title: "Photos", type: "photo" },
            { title: "No Key", type: "movie" },
            { key: 5, type: "movie" },
            { key: "6", title: "Bad Type", type: "unknown" },
          ],
        },
      });
    }) as typeof fetch;

    const sections = await client().sections();
    assert.deepEqual(sections, [
      { key: "1", title: "Movies", type: "movie" },
      { key: "2", title: "TV Shows", type: "show" },
    ]);
  });
});

describe("plexServer.sectionItems", () => {
  it("pages and parses library items with best-effort fields", async () => {
    let requestedUrl: string | null = null;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return jsonResponse(200, {
        MediaContainer: {
          totalSize: 120,
          Metadata: [
            {
              ratingKey: 1001,
              type: "movie",
              title: "Inception",
              year: 2010,
              thumb: "/library/metadata/1001/thumb/1",
              addedAt: 1700000000,
              Guid: [{ id: "tmdb://27205" }, { id: "imdb://tt1375666" }],
            },
            {
              ratingKey: 2002,
              type: "show",
              title: "Severance",
              Guid: [{ id: "tmdb://95396" }],
            },
            // Missing ratingKey — skipped.
            { type: "movie", title: "Ghost" },
            // Malformed guid rows should not throw.
            {
              ratingKey: 3003,
              type: "movie",
              title: "No TMDB",
              Guid: [{ id: "imdb://tt0111161" }, { id: 123 }],
            },
          ],
        },
      });
    }) as typeof fetch;

    const result = await client().sectionItems({
      sectionKey: "1",
      sort: "added",
      start: 50,
      size: 25,
    });

    assert.ok(requestedUrl);
    const parsed = new URL(requestedUrl);
    assert.equal(parsed.pathname, "/library/sections/1/all");
    assert.equal(parsed.searchParams.get("sort"), "addedAt:desc");
    assert.equal(parsed.searchParams.get("includeGuids"), "1");
    assert.equal(parsed.searchParams.get("X-Plex-Container-Start"), "50");
    assert.equal(parsed.searchParams.get("X-Plex-Container-Size"), "25");
    assert.equal(parsed.searchParams.get("genre"), null);
    assert.equal(parsed.searchParams.get("unwatched"), null);

    assert.equal(result.totalSize, 120);
    assert.deepEqual(result.items, [
      {
        ratingKey: "1001",
        type: "movie",
        title: "Inception",
        year: 2010,
        thumb: "/library/metadata/1001/thumb/1",
        addedAt: 1700000000,
        tmdbId: 27205,
      },
      {
        ratingKey: "2002",
        type: "show",
        title: "Severance",
        year: null,
        thumb: null,
        addedAt: null,
        tmdbId: 95396,
      },
      {
        ratingKey: "3003",
        type: "movie",
        title: "No TMDB",
        year: null,
        thumb: null,
        addedAt: null,
        tmdbId: null,
      },
    ]);
  });

  it("falls back to container size then items length for totalSize", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        MediaContainer: {
          size: 3,
          Metadata: [{ ratingKey: 1, type: "movie", title: "A" }],
        },
      })) as typeof fetch;

    const result = await client().sectionItems({
      sectionKey: "2",
      sort: "title",
      start: 0,
      size: 50,
    });
    assert.equal(result.totalSize, 3);
  });

  it("adds genre and unwatched to the Plex query when provided", async () => {
    let requestedUrl: string | null = null;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return jsonResponse(200, {
        MediaContainer: { totalSize: 0, Metadata: [] },
      });
    }) as typeof fetch;

    await client().sectionItems({
      sectionKey: "1",
      sort: "title",
      start: 0,
      size: 50,
      genre: "1131",
      unwatched: true,
    });

    assert.ok(requestedUrl);
    const parsed = new URL(requestedUrl);
    assert.equal(parsed.searchParams.get("genre"), "1131");
    assert.equal(parsed.searchParams.get("unwatched"), "1");
    assert.equal(parsed.searchParams.get("sort"), "titleSort:asc");
    assert.equal(parsed.searchParams.get("includeGuids"), "1");
    assert.equal(parsed.searchParams.get("X-Plex-Container-Start"), "0");
    assert.equal(parsed.searchParams.get("X-Plex-Container-Size"), "50");
    assert.equal(parsed.pathname, "/library/sections/1/all");
  });

  it("uses the firstCharacter path when provided, including # as %23", async () => {
    let requestedUrlB: string | null = null;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrlB =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return jsonResponse(200, {
        MediaContainer: { size: 6, Metadata: [] },
      });
    }) as typeof fetch;

    await client().sectionItems({
      sectionKey: "1",
      sort: "title",
      start: 0,
      size: 48,
      firstCharacter: "B",
      genre: "1131",
      unwatched: true,
    });

    assert.ok(requestedUrlB);
    const parsedB = new URL(requestedUrlB);
    assert.equal(parsedB.pathname, "/library/sections/1/firstCharacter/B");
    assert.equal(parsedB.searchParams.get("genre"), "1131");
    assert.equal(parsedB.searchParams.get("unwatched"), "1");
    assert.equal(parsedB.searchParams.get("sort"), "titleSort:asc");
    assert.equal(parsedB.searchParams.get("includeGuids"), "1");

    let requestedUrlHash: string | null = null;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrlHash =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return jsonResponse(200, {
        MediaContainer: { size: 2, Metadata: [] },
      });
    }) as typeof fetch;

    await client().sectionItems({
      sectionKey: "1",
      sort: "title",
      start: 0,
      size: 48,
      firstCharacter: "#",
    });

    assert.ok(requestedUrlHash);
    const parsedHash = new URL(requestedUrlHash);
    assert.equal(parsedHash.pathname, "/library/sections/1/firstCharacter/%23");
  });
});

describe("plexServer.sectionGenres", () => {
  it("parses Directory[] into { id, title }, skipping malformed rows", async () => {
    let requestedUrl: string | null = null;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return jsonResponse(200, {
        MediaContainer: {
          Directory: [
            { key: 1131, title: "Action" },
            { key: "18", title: "Drama" },
            { title: "No Key" },
            { key: 999, type: "genre" },
            { key: 100, title: 123 },
          ],
        },
      });
    }) as typeof fetch;

    const genres = await client().sectionGenres("1");

    assert.equal(requestedUrl, `${BASE_URL}/library/sections/1/genre`);
    assert.deepEqual(genres, [
      { id: "1131", title: "Action" },
      { id: "18", title: "Drama" },
    ]);
  });
});

describe("plexServer.sectionFirstCharacters", () => {
  it("parses Directory[] into { label, count }, skipping malformed rows", async () => {
    let requestedUrl: string | null = null;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return jsonResponse(200, {
        MediaContainer: {
          Directory: [
            { key: 1, title: "#", size: 2 },
            { key: 2, title: "A", size: 11 },
            { key: 3, title: "B", size: 6 },
            { size: 99 },
            { key: 4, size: 5 },
            { key: 5, title: 123, size: 1 },
          ],
        },
      });
    }) as typeof fetch;

    const characters = await client().sectionFirstCharacters("1");

    assert.equal(requestedUrl, `${BASE_URL}/library/sections/1/firstCharacter`);
    assert.deepEqual(characters, [
      { label: "#", count: 2 },
      { label: "A", count: 11 },
      { label: "B", count: 6 },
    ]);
  });
});

describe("plexServer.fetchImage", () => {
  const IMAGE_PATH = "/library/metadata/3613/thumb/1780131692";
  const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]);

  function imageResponse(
    status: number,
    body: Uint8Array,
    contentType = "image/jpeg",
  ): Response {
    return new Response(body, {
      status,
      headers: { "Content-Type": contentType },
    });
  }

  it("fetches with the owner token and returns ok/status/contentType/body", async () => {
    let requestedUrl: string | null = null;
    let requestedToken: string | null = null;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      requestedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const headers = init?.headers;
      if (headers instanceof Headers) {
        requestedToken = headers.get("X-Plex-Token");
      } else if (Array.isArray(headers)) {
        const entry = headers.find(([key]) => key === "X-Plex-Token");
        requestedToken = entry ? entry[1] : null;
      } else if (headers && typeof headers === "object") {
        requestedToken = (headers as Record<string, string>)["X-Plex-Token"];
      }
      return imageResponse(200, IMAGE_BYTES);
    }) as typeof fetch;

    const result = await client().fetchImage(IMAGE_PATH);

    assert.equal(requestedUrl, `${BASE_URL}${IMAGE_PATH}`);
    assert.equal(requestedToken, TOKEN);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.contentType, "image/jpeg");
    assert.deepEqual(result.body, Buffer.from(IMAGE_BYTES));
  });

  it("returns ok:false with an empty body on a non-OK upstream response", async () => {
    globalThis.fetch = (async () =>
      imageResponse(404, new Uint8Array())) as typeof fetch;

    const result = await client().fetchImage(IMAGE_PATH);

    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.equal(result.body.length, 0);
  });

  it("throws PlexServerUpstreamError on network failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;

    await assert.rejects(
      client().fetchImage(IMAGE_PATH),
      (err: unknown) => {
        assert.ok(err instanceof PlexServerUpstreamError);
        assert.equal(err.status, 502);
        assert.match(err.message, /connection refused/);
        return true;
      },
    );
  });
});
