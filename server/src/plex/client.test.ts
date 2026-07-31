// Characterization tests for the plex.tv PIN login client in plex/client.ts:
// createPin, buildAuthUrl, checkPin, getUser.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PlexUpstreamError, createPlexClient } from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const CLIENT_ID = "test-client-id";
const PRODUCT = "TyflixTest";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client() {
  return createPlexClient({ clientId: CLIENT_ID, product: PRODUCT });
}

describe("createPin", () => {
  it("resolves {id, code} from a 2xx body", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { id: 12345, code: "ABCD" })) as typeof fetch;

    assert.deepEqual(await client().createPin(), { id: 12345, code: "ABCD" });
  });

  it("POSTs pins?strong=true with client identifier and product headers", async () => {
    let requestedUrl: string | null = null;
    let requestedMethod: string | null = null;
    let requestedClientId: string | null = null;
    let requestedProduct: string | null = null;

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
      requestedClientId = headers.get("X-Plex-Client-Identifier");
      requestedProduct = headers.get("X-Plex-Product");
      return jsonResponse(201, { id: 1, code: "CODE" });
    }) as typeof fetch;

    await client().createPin();

    assert.equal(
      requestedUrl,
      "https://clients.plex.tv/api/v2/pins?strong=true",
    );
    assert.equal(requestedMethod, "POST");
    assert.equal(requestedClientId, CLIENT_ID);
    assert.equal(requestedProduct, PRODUCT);
  });

  it("rejects with PlexUpstreamError carrying the non-2xx status", async () => {
    globalThis.fetch = (async () => jsonResponse(503, {})) as typeof fetch;

    await assert.rejects(client().createPin(), (err: unknown) => {
      assert.ok(err instanceof PlexUpstreamError);
      assert.equal(err.status, 503);
      return true;
    });
  });

  it("rejects with PlexUpstreamError when id/code are missing or wrong-typed", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { id: "not-a-number", code: "ABCD" })) as typeof fetch;

    await assert.rejects(client().createPin(), (err: unknown) => {
      assert.ok(err instanceof PlexUpstreamError);
      assert.equal(err.status, 200);
      return true;
    });

    globalThis.fetch = (async () =>
      jsonResponse(201, { id: 1 })) as typeof fetch;

    await assert.rejects(client().createPin(), (err: unknown) => {
      assert.ok(err instanceof PlexUpstreamError);
      assert.equal(err.status, 201);
      return true;
    });
  });
});

describe("buildAuthUrl", () => {
  it("returns an app.plex.tv auth URL carrying clientID, code, and product", () => {
    const url = client().buildAuthUrl("PINCODE");

    assert.ok(url.startsWith("https://app.plex.tv/auth#?"));
    const query = url.slice("https://app.plex.tv/auth#?".length);
    const params = new URLSearchParams(query);
    assert.equal(params.get("clientID"), CLIENT_ID);
    assert.equal(params.get("code"), "PINCODE");
    assert.equal(params.get("context[device][product]"), PRODUCT);
  });
});

describe("checkPin", () => {
  it("resolves {authToken: null} when authToken is absent", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { id: 1, code: "X" })) as typeof fetch;

    assert.deepEqual(await client().checkPin(1), { authToken: null });
  });

  it("resolves {authToken: null} when authToken is explicitly null", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { authToken: null })) as typeof fetch;

    assert.deepEqual(await client().checkPin(1), { authToken: null });
  });

  it("resolves the authToken string when present", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { authToken: "plex-token-abc" })) as typeof fetch;

    assert.deepEqual(await client().checkPin(1), {
      authToken: "plex-token-abc",
    });
  });

  it("rejects with PlexUpstreamError when the body is not an object", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, null)) as typeof fetch;

    await assert.rejects(client().checkPin(1), (err: unknown) => {
      assert.ok(err instanceof PlexUpstreamError);
      assert.equal(err.status, 200);
      return true;
    });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify("bare-string"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    await assert.rejects(client().checkPin(1), (err: unknown) => {
      assert.ok(err instanceof PlexUpstreamError);
      assert.equal(err.status, 200);
      return true;
    });
  });

  it("rejects with PlexUpstreamError when authToken is present but not a string", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { authToken: 12345 })) as typeof fetch;

    await assert.rejects(client().checkPin(1), (err: unknown) => {
      assert.ok(err instanceof PlexUpstreamError);
      assert.equal(err.status, 200);
      return true;
    });
  });

  it("rejects with PlexUpstreamError carrying the non-2xx status", async () => {
    globalThis.fetch = (async () => jsonResponse(404, {})) as typeof fetch;

    await assert.rejects(client().checkPin(1), (err: unknown) => {
      assert.ok(err instanceof PlexUpstreamError);
      assert.equal(err.status, 404);
      return true;
    });
  });
});

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
