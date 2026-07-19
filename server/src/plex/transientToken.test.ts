import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  PlexTransientError,
  createTransientTokenMinter,
} from "./transientToken";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BASE_URL = "http://10.0.0.10:32400";
const CLIENT_ID = "client-id";
const USER_TOKEN = "user-durable-token";
const TRANSIENT = "transient-24b68e46-3eb5-449e-8295-ff59e9a5e6cb";

function response(status: number, body: string, contentType: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

function minter() {
  return createTransientTokenMinter({ baseUrl: BASE_URL, clientId: CLIENT_ID });
}

// Records the single /security/token call so we can assert URL + headers.
function stubFetch(make: () => Response) {
  const calls: Array<{ url: string; headers: Headers }> = [];
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
    calls.push({ url, headers: new Headers(init?.headers) });
    return make();
  }) as typeof fetch;
  return calls;
}

describe("createTransientTokenMinter", () => {
  it("mints from an XML body and sends the right request", async () => {
    const calls = stubFetch(() =>
      response(
        200,
        `<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer size="0" token="${TRANSIENT}"></MediaContainer>`,
        "application/xml",
      ),
    );

    const token = await minter().mint(USER_TOKEN);
    assert.equal(token, TRANSIENT);

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `${BASE_URL}/security/token?type=delegation&scope=all`,
    );
    assert.equal(calls[0].headers.get("X-Plex-Token"), USER_TOKEN);
    assert.equal(calls[0].headers.get("X-Plex-Client-Identifier"), CLIENT_ID);
  });

  it("mints from a JSON body (authToken field)", async () => {
    stubFetch(() =>
      response(
        200,
        JSON.stringify({ MediaContainer: { size: 0, authToken: TRANSIENT } }),
        "application/json",
      ),
    );

    const token = await minter().mint(USER_TOKEN);
    assert.equal(token, TRANSIENT);
  });

  it("throws PlexTransientError on a non-OK response", async () => {
    stubFetch(() => response(401, "Unauthorized", "text/plain"));

    await assert.rejects(
      () => minter().mint(USER_TOKEN),
      (err: unknown) => err instanceof PlexTransientError,
    );
  });

  it("throws PlexTransientError when no token can be extracted", async () => {
    stubFetch(() =>
      response(
        200,
        `<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer size="0"></MediaContainer>`,
        "application/xml",
      ),
    );

    await assert.rejects(
      () => minter().mint(USER_TOKEN),
      (err: unknown) => err instanceof PlexTransientError,
    );
  });
});
