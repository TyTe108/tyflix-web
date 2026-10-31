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
  const calls = {
    identity: 0,
    sharedServers: 0,
    requests: [] as { url: string; headers: Headers }[],
  };
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.requests.push({ url, headers: new Headers(init?.headers) });

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

  it("reads userID and accessToken at attribute boundaries when prefixes collide", async () => {
    stubFetch({
      sharedServers: () =>
        textResponse(
          200,
          `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer machineIdentifier="${MACHINE_ID}" size="1">
  <SharedServer id="1" myuserID="666" xaccessToken="wrong" userID="777" accessToken="right"/>
</MediaContainer>`,
        ),
    });

    const token = await resolver().resolveAccessToken(777);
    assert.equal(token, "right");
  });

  it("parses SharedServer tags with mixed-case attribute names", async () => {
    stubFetch({
      sharedServers: () =>
        textResponse(
          200,
          `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer machineIdentifier="${MACHINE_ID}" size="1">
  <SharedServer id="99" serverAccessToken="wrong-token" userID="777" accessToken="right-token" name="Test"/>
</MediaContainer>`,
        ),
    });

    const token = await resolver().resolveAccessToken(777);
    assert.equal(token, "right-token");
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

  // Guards the owner token: shared_servers must send it as a header, not in the URL.
  it("requests shared_servers with the owner token in a header and no query string", async () => {
    const calls = stubFetch();

    await resolver().resolveAccessToken(101);

    const shared = calls.requests.find((call) =>
      call.url.includes("/shared_servers"),
    );
    assert.ok(shared);
    assert.equal(
      shared.url,
      "https://plex.tv/api/servers/machine-abc/shared_servers",
    );
    assert.equal(shared.headers.get("X-Plex-Token"), OWNER_TOKEN);
    assert.equal(shared.headers.get("X-Plex-Client-Identifier"), CLIENT_ID);
  });

  // Guards the owner token: a non-OK shared_servers answer names the call and the status, not the URL.
  it("names the status when shared_servers answers non-OK, without the owner token", async () => {
    for (const status of [503, 429, 401]) {
      stubFetch({
        sharedServers: () => textResponse(status, "no"),
      });

      await assert.rejects(
        () => resolver().resolveAccessToken(101),
        (err: unknown) => {
          assert.ok(err instanceof PlexSharedServerAccessError);
          assert.equal(err.message, `plex.tv shared_servers failed (${status})`);
          assert.equal(err.message.includes(OWNER_TOKEN), false);
          return true;
        },
      );
    }
  });

  // Guards the PMS address: a non-OK /identity answer names the call and the status, not the URL.
  it("names the status when /identity answers non-OK, without the base URL or token", async () => {
    stubFetch({
      identity: () => jsonResponse(500, {}),
    });

    await assert.rejects(
      () => resolver().resolveAccessToken(101),
      (err: unknown) => {
        assert.ok(err instanceof PlexSharedServerAccessError);
        assert.equal(err.message, "Plex /identity failed (500)");
        assert.equal(err.message.includes(OWNER_TOKEN), false);
        assert.equal(err.message.includes(BASE_URL), false);
        return true;
      },
    );
  });
});
