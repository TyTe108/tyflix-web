import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  PlexConnectionError,
  createPlexConnectionResolver,
} from "./connection";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BASE_URL = "http://10.0.0.10:32400";
const TOKEN = "owner-token";
const CLIENT_ID = "client-id";
const MACHINE_ID = "machine-abc";

const DIRECT_URI = "https://1-2-3-4.machine-abc.plex.direct:32400";
const LOCAL_URI = "https://10-0-0-10.machine-abc.plex.direct:32400";
const RELAY_URI = "https://relay.machine-abc.plex.direct:8443";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function resolver() {
  return createPlexConnectionResolver({
    baseUrl: BASE_URL,
    token: TOKEN,
    clientId: CLIENT_ID,
  });
}

type StubHandlers = {
  identity?: () => Response;
  resources?: () => Response;
};

// Routes /identity and plex.tv/api/v2/resources to canned responses and records
// how many times each was hit (to prove caching).
function stubFetch(handlers: StubHandlers) {
  const calls = { identity: 0, resources: 0 };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.includes("/identity")) {
      calls.identity += 1;
      return handlers.identity
        ? handlers.identity()
        : jsonResponse(200, {
            MediaContainer: { machineIdentifier: MACHINE_ID },
          });
    }
    if (url.includes("plex.tv/api/v2/resources")) {
      calls.resources += 1;
      return handlers.resources
        ? handlers.resources()
        : jsonResponse(200, []);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return calls;
}

describe("createPlexConnectionResolver", () => {
  it("selects both local and remote direct connections from a mixed list", async () => {
    stubFetch({
      resources: () =>
        jsonResponse(200, [
          {
            clientIdentifier: "someone-else",
            connections: [
              {
                protocol: "https",
                uri: "https://other.plex.direct:32400",
                local: false,
                relay: false,
              },
            ],
          },
          {
            clientIdentifier: MACHINE_ID,
            connections: [
              {
                protocol: "https",
                uri: LOCAL_URI,
                local: true,
                relay: false,
              },
              {
                protocol: "https",
                uri: DIRECT_URI,
                local: false,
                relay: false,
              },
              {
                protocol: "https",
                uri: RELAY_URI,
                local: false,
                relay: true,
              },
            ],
          },
        ]),
    });

    const connections = await resolver().resolveConnections();
    assert.deepEqual(connections, { local: LOCAL_URI, remote: DIRECT_URI });
  });

  it("excludes relay connections from both local and remote", async () => {
    stubFetch({
      resources: () =>
        jsonResponse(200, [
          {
            clientIdentifier: MACHINE_ID,
            connections: [
              // A local relay must NOT become the local URI.
              {
                protocol: "https",
                uri: "https://local-relay.machine-abc.plex.direct:8443",
                local: true,
                relay: true,
              },
              {
                protocol: "https",
                uri: LOCAL_URI,
                local: true,
                relay: false,
              },
              {
                protocol: "https",
                uri: DIRECT_URI,
                local: false,
                relay: false,
              },
              // A remote relay must NOT become the remote URI.
              {
                protocol: "https",
                uri: RELAY_URI,
                local: false,
                relay: true,
              },
            ],
          },
        ]),
    });

    const connections = await resolver().resolveConnections();
    assert.deepEqual(connections, { local: LOCAL_URI, remote: DIRECT_URI });
  });

  it("returns local null when the server advertises no local connection", async () => {
    stubFetch({
      resources: () =>
        jsonResponse(200, [
          {
            clientIdentifier: MACHINE_ID,
            connections: [
              {
                protocol: "https",
                uri: DIRECT_URI,
                local: false,
                relay: false,
              },
              {
                protocol: "https",
                uri: RELAY_URI,
                local: false,
                relay: true,
              },
            ],
          },
        ]),
    });

    const connections = await resolver().resolveConnections();
    assert.deepEqual(connections, { local: null, remote: DIRECT_URI });
  });

  it("caches the resolved connections so repeated calls don't re-hit plex.tv", async () => {
    const calls = stubFetch({
      resources: () =>
        jsonResponse(200, [
          {
            clientIdentifier: MACHINE_ID,
            connections: [
              {
                protocol: "https",
                uri: LOCAL_URI,
                local: true,
                relay: false,
              },
              {
                protocol: "https",
                uri: DIRECT_URI,
                local: false,
                relay: false,
              },
            ],
          },
        ]),
    });

    const r = resolver();
    const first = await r.resolveConnections();
    const second = await r.resolveConnections();

    assert.deepEqual(first, { local: LOCAL_URI, remote: DIRECT_URI });
    assert.equal(second, first);
    assert.equal(calls.identity, 1);
    assert.equal(calls.resources, 1);
  });

  it("throws when only relay/local connections are available (no remote)", async () => {
    stubFetch({
      resources: () =>
        jsonResponse(200, [
          {
            clientIdentifier: MACHINE_ID,
            connections: [
              {
                protocol: "https",
                uri: LOCAL_URI,
                local: true,
                relay: false,
              },
              {
                protocol: "https",
                uri: RELAY_URI,
                local: false,
                relay: true,
              },
            ],
          },
        ]),
    });

    await assert.rejects(
      () => resolver().resolveConnections(),
      (err: unknown) => err instanceof PlexConnectionError,
    );
  });

  it("throws when no resource matches our machineIdentifier", async () => {
    stubFetch({
      resources: () =>
        jsonResponse(200, [
          {
            clientIdentifier: "not-our-server",
            connections: [
              {
                protocol: "https",
                uri: DIRECT_URI,
                local: false,
                relay: false,
              },
            ],
          },
        ]),
    });

    await assert.rejects(
      () => resolver().resolveConnections(),
      (err: unknown) => err instanceof PlexConnectionError,
    );
  });

  it("throws when /identity fails", async () => {
    stubFetch({
      identity: () => jsonResponse(500, {}),
    });

    await assert.rejects(
      () => resolver().resolveConnections(),
      (err: unknown) => err instanceof PlexConnectionError,
    );
  });
});
