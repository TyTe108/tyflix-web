import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  SeerrUpstreamError,
  createSeerrClient,
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

function userRow(overrides: Partial<{
  id: number;
  plexId: number;
  plexUsername: string;
  displayName: string;
  email: string | null;
  permissions: number;
}> = {}) {
  return {
    id: 1,
    plexId: 100,
    plexUsername: "alice",
    displayName: "Alice",
    email: "a@example.com",
    permissions: 0,
    ...overrides,
  };
}

describe("createSeerrClient().getUserByPlexId", () => {
  it("requests with X-Api-Key and returns the matching user", async () => {
    const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({
        url: String(input),
        headers: init?.headers,
      });
      return jsonResponse(200, {
        pageInfo: { results: 1 },
        results: [userRow({ id: 9, plexId: 42, permissions: 2 })],
      });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "secret-key",
    });
    const user = await seerr.getUserByPlexId(42);

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "http://seerr:5055/api/v1/user?take=100&skip=0",
    );
    const headers = new Headers(calls[0].headers);
    assert.equal(headers.get("X-Api-Key"), "secret-key");
    assert.equal(headers.get("Accept"), "application/json");
    assert.deepEqual(user, {
      id: 9,
      plexId: 42,
      plexUsername: "alice",
      displayName: "Alice",
      email: "a@example.com",
      permissions: 2,
    });
  });

  it("paginates with skip increments of 100 until the match is found", async () => {
    const skips: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      skips.push(url.searchParams.get("skip") ?? "");
      const skip = Number(url.searchParams.get("skip"));
      if (skip === 0) {
        return jsonResponse(200, {
          pageInfo: { results: 101 },
          results: Array.from({ length: 100 }, (_, i) =>
            userRow({ id: i + 1, plexId: 1000 + i }),
          ),
        });
      }
      return jsonResponse(200, {
        pageInfo: { results: 101 },
        results: [userRow({ id: 101, plexId: 777, displayName: "Found" })],
      });
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    const user = await seerr.getUserByPlexId(777);

    assert.deepEqual(skips, ["0", "100"]);
    assert.equal(user?.plexId, 777);
    assert.equal(user?.displayName, "Found");
  });

  it("returns null when no user matches the plexId", async () => {
    globalThis.fetch = async () =>
      jsonResponse(200, {
        pageInfo: { results: 1 },
        results: [userRow({ plexId: 1 })],
      });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });
    assert.equal(await seerr.getUserByPlexId(999), null);
  });

  it("throws SeerrUpstreamError on a non-2xx response", async () => {
    globalThis.fetch = async () => jsonResponse(503, { message: "down" });

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () => seerr.getUserByPlexId(1),
      (err: unknown) =>
        err instanceof SeerrUpstreamError &&
        err.status === 503 &&
        err.message.includes("503"),
    );
  });

  it("throws SeerrUpstreamError when fetch itself fails", async () => {
    globalThis.fetch = async () => {
      throw new Error("network down");
    };

    const seerr = createSeerrClient({
      baseUrl: "http://seerr:5055",
      apiKey: "k",
    });

    await assert.rejects(
      () => seerr.getUserByPlexId(1),
      (err: unknown) =>
        err instanceof SeerrUpstreamError &&
        err.message.includes("network down"),
    );
  });
});
