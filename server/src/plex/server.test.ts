import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createPlexServerClient } from "./server";

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
            },
            {
              ratingKey: 301,
              parentIndex: 2,
              index: 1,
              title: "Season Two Opener",
            },
            {
              ratingKey: 201,
              parentIndex: 1,
              index: 1,
              title: "Pilot",
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
      { ratingKey: "201", seasonNumber: 1, episodeNumber: 1, title: "Pilot" },
      { ratingKey: "202", seasonNumber: 1, episodeNumber: 2, title: "Second" },
      {
        ratingKey: "301",
        seasonNumber: 2,
        episodeNumber: 1,
        title: "Season Two Opener",
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
      { ratingKey: "500", seasonNumber: 1, episodeNumber: 1, title: "" },
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
