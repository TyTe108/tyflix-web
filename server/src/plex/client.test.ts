// Characterization tests for the plex.tv account client in plex/client.ts:
// getUser.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PlexUpstreamError, createPlexClient } from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const CLIENT_ID = "test-client-id";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client() {
  return createPlexClient({ clientId: CLIENT_ID });
}

describe("getUser", () => {
  it("resolves a mapped PlexUser from a full 2xx body", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        id: 100,
        username: "alice",
        email: "a@example.com",
        thumb: "https://plex/avatar.png",
      })) as typeof fetch;

    assert.deepEqual(await client().getUser("token"), {
      id: 100,
      username: "alice",
      email: "a@example.com",
      thumb: "https://plex/avatar.png",
    });
  });

  it("maps absent, null, or non-string email/thumb to null", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        id: 100,
        username: "alice",
      })) as typeof fetch;

    assert.deepEqual(await client().getUser("token"), {
      id: 100,
      username: "alice",
      email: null,
      thumb: null,
    });

    globalThis.fetch = (async () =>
      jsonResponse(200, {
        id: 100,
        username: "alice",
        email: null,
        thumb: null,
      })) as typeof fetch;

    assert.deepEqual(await client().getUser("token"), {
      id: 100,
      username: "alice",
      email: null,
      thumb: null,
    });

    globalThis.fetch = (async () =>
      jsonResponse(200, {
        id: 100,
        username: "alice",
        email: 1,
        thumb: { url: "x" },
      })) as typeof fetch;

    assert.deepEqual(await client().getUser("token"), {
      id: 100,
      username: "alice",
      email: null,
      thumb: null,
    });
  });

  it("rejects with PlexUpstreamError carrying the non-2xx status", async () => {
    globalThis.fetch = (async () => jsonResponse(401, {})) as typeof fetch;

    await assert.rejects(client().getUser("token"), (err: unknown) => {
      assert.ok(err instanceof PlexUpstreamError);
      assert.equal(err.status, 401);
      return true;
    });
  });

  it("rejects with PlexUpstreamError when id or username are missing or wrong-typed", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { id: "100", username: "alice" })) as typeof fetch;

    await assert.rejects(client().getUser("token"), (err: unknown) => {
      assert.ok(err instanceof PlexUpstreamError);
      assert.equal(err.status, 200);
      return true;
    });

    globalThis.fetch = (async () =>
      jsonResponse(200, { id: 100 })) as typeof fetch;

    await assert.rejects(client().getUser("token"), (err: unknown) => {
      assert.ok(err instanceof PlexUpstreamError);
      assert.equal(err.status, 200);
      return true;
    });
  });
});
