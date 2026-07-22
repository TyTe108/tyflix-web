import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  PlexSharedServerAccessError,
  createSharedServerAccessResolver,
} from "./sharedServerAccess";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BASE_URL = "http://10.0.0.10:32400";
const OWNER_TOKEN = "owner-token";
const CLIENT_ID = "client-id";
const MACHINE_ID = "machine-abc";

const SHARED_SERVERS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer friendlyName="tyflix" machineIdentifier="${MACHINE_ID}" size="3">
  <SharedServer id="1" userID="101" username="allen" accessToken="shared-token-allen" name="Allen"/>
  <SharedServer id="2" userID="202" username="sam" accessToken="shared-token-sam" name="Sam"/>
  <SharedServer id="3" username="broken" name="MissingAttrs"/>
</MediaContainer>`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/xml" },
  });
}

function resolver() {
  return createSharedServerAccessResolver({
    baseUrl: BASE_URL,
    ownerToken: OWNER_TOKEN,
    clientId: CLIENT_ID,
  });
}

type StubHandlers = {
  identity?: () => Response;
  sharedServers?: () => Response;
};

// Routes /identity and plex.tv shared_servers to canned responses and records
// how many times each was hit (to prove caching).
function stubFetch(handlers: StubHandlers = {}) {
  const calls = { identity: 0, sharedServers: 0 };
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
    if (url.includes("/shared_servers")) {
      calls.sharedServers += 1;
      return handlers.sharedServers
        ? handlers.sharedServers()
        : textResponse(200, SHARED_SERVERS_XML);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return calls;
}

describe("createSharedServerAccessResolver", () => {
  it("returns the per-server accessToken for a plexId present in the list", async () => {
    stubFetch();

    const token = await resolver().resolveAccessToken(101);
    assert.equal(token, "shared-token-allen");
  });

  it("returns null when the plexId is not a shared user", async () => {
    stubFetch();

    const token = await resolver().resolveAccessToken(999);
    assert.equal(token, null);
  });

  it("caches the shared_servers map so repeated calls don't re-hit plex.tv", async () => {
    const calls = stubFetch();

    const r = resolver();
    const first = await r.resolveAccessToken(101);
    const second = await r.resolveAccessToken(202);

    assert.equal(first, "shared-token-allen");
    assert.equal(second, "shared-token-sam");
    assert.equal(calls.identity, 1);
    assert.equal(calls.sharedServers, 1);
  });

  it("throws when shared_servers returns a non-OK response", async () => {
    stubFetch({
      sharedServers: () => textResponse(500, "boom"),
    });

    await assert.rejects(
      () => resolver().resolveAccessToken(101),
      (err: unknown) => err instanceof PlexSharedServerAccessError,
    );
  });

  it("throws when the shared_servers request fails on the network", async () => {
    stubFetch({
      sharedServers: () => {
        throw new Error("network down");
      },
    });

    await assert.rejects(
      () => resolver().resolveAccessToken(101),
      (err: unknown) => err instanceof PlexSharedServerAccessError,
    );
  });

  it("throws when /identity fails", async () => {
    stubFetch({
      identity: () => jsonResponse(500, {}),
    });

    await assert.rejects(
      () => resolver().resolveAccessToken(101),
      (err: unknown) => err instanceof PlexSharedServerAccessError,
    );
  });
});
