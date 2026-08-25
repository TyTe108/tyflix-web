import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  TransmissionUpstreamError,
  createTransmissionClient,
} from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.timers.reset();
});

const SESSION_HEADER = "X-Transmission-Session-Id";
const RPC_URL = "http://transmission:9091/transmission/rpc";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function conflictResponse(sessionId: string): Response {
  return new Response("", {
    status: 409,
    headers: { [SESSION_HEADER]: sessionId },
  });
}

function successResponse(arguments_: unknown): Response {
  return jsonResponse(200, { arguments: arguments_, result: "success" });
}

describe("createTransmissionClient", () => {
  it("exposes only the supported torrent reads and mutations", () => {
    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });
    assert.deepEqual(Object.keys(client).sort(), [
      "getSessionStats",
      "listTorrents",
      "startTorrent",
      "stopTorrent",
    ]);
  });

  it("includes optional torrent hashes in the torrent-get arguments", async () => {
    let body: unknown;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return successResponse({ torrents: [] });
    };
    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });

    await client.listTorrents(["hashString"], ["abc123"]);

    assert.deepEqual(body, {
      method: "torrent-get",
      arguments: { fields: ["hashString"], ids: ["abc123"] },
    });
  });

  it("sends torrent-stop with the selected hash", async () => {
    let body: unknown;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return successResponse({});
    };
    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });

    await client.stopTorrent("abc123");

    assert.deepEqual(body, {
      method: "torrent-stop",
      arguments: { ids: ["abc123"] },
    });
  });
});

describe("createTransmissionClient CSRF handshake", () => {
  it("replays the identical request exactly once after a 409", async () => {
    const sessionId = "csrf-token-1";
    const calls: Array<{ url: string; session: string | null; body: unknown }> =
      [];

    globalThis.fetch = async (input, init) => {
      calls.push({
        url: String(input),
        session: new Headers(init?.headers).get(SESSION_HEADER),
        body: JSON.parse(String(init?.body)),
      });
      if (calls.length === 1) {
        return conflictResponse(sessionId);
      }
      return successResponse({ torrents: [] });
    };

    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });
    const fields = ["id", "name"];
    const result = await client.listTorrents(fields);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, RPC_URL);
    assert.equal(calls[1]?.url, RPC_URL);
    assert.equal(calls[0]?.session, null);
    assert.equal(calls[1]?.session, sessionId);
    assert.deepEqual(calls[0]?.body, calls[1]?.body);
    assert.deepEqual(calls[0]?.body, {
      method: "torrent-get",
      arguments: { fields },
    });
    assert.deepEqual(result, { torrents: [] });
  });

  it("reuses the cached token so a second call makes one HTTP request", async () => {
    const sessionId = "csrf-token-cached";
    let calls = 0;

    globalThis.fetch = async (_input, init) => {
      calls += 1;
      const session = new Headers(init?.headers).get(SESSION_HEADER);
      if (session !== sessionId) {
        return conflictResponse(sessionId);
      }
      return successResponse({
        activeTorrentCount: 0,
        downloadSpeed: 0,
        pausedTorrentCount: 0,
        torrentCount: 0,
        uploadSpeed: 0,
      });
    };

    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });

    await client.getSessionStats();
    assert.equal(calls, 2);

    await client.getSessionStats();
    assert.equal(calls, 3);
  });

  it("throws TransmissionUpstreamError on a 409 replay and does not retry a third time", async () => {
    let calls = 0;

    globalThis.fetch = async () => {
      calls += 1;
      return conflictResponse("never-accepted");
    };

    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });

    await assert.rejects(
      () => client.getSessionStats(),
      (err: unknown) =>
        err instanceof TransmissionUpstreamError && err.status === 409,
    );
    assert.equal(calls, 2);
  });
});

describe("createTransmissionClient RPC result", () => {
  it('throws TransmissionUpstreamError when result is "no method name"', async () => {
    globalThis.fetch = async () =>
      jsonResponse(200, { arguments: {}, result: "no method name" });

    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });

    await assert.rejects(
      () => client.getSessionStats(),
      (err: unknown) =>
        err instanceof TransmissionUpstreamError &&
        err.message.includes("no method name") &&
        err.status === 200,
    );
  });

  it("throws TransmissionUpstreamError with status 502 when fetch rejects", async () => {
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };

    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });

    await assert.rejects(
      () => client.listTorrents(["id"]),
      (err: unknown) =>
        err instanceof TransmissionUpstreamError &&
        err.status === 502 &&
        err.message.includes("connection refused"),
    );
  });

  it("throws TransmissionUpstreamError on a non-2xx that is not 409", async () => {
    globalThis.fetch = async () => jsonResponse(503, { message: "down" });

    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });

    await assert.rejects(
      () => client.getSessionStats(),
      (err: unknown) =>
        err instanceof TransmissionUpstreamError && err.status === 503,
    );
  });

  it("does not turn a transport failure into an empty torrent list", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });

    await assert.rejects(
      () => client.listTorrents(["id", "name"]),
      (err: unknown) => err instanceof TransmissionUpstreamError,
    );
  });

  it("returns an empty torrents array when Transmission has no torrents", async () => {
    globalThis.fetch = async () => successResponse({ torrents: [] });

    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });

    assert.deepEqual(await client.listTorrents(["id"]), { torrents: [] });
  });

  it("passes a 10 second AbortSignal to fetch", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let signal: AbortSignal | undefined;
    globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });

    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });
    const pending = client.getSessionStats();

    assert.ok(signal);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(10_000);
    assert.equal(signal.aborted, true);

    await assert.rejects(
      pending,
      (err: unknown) =>
        err instanceof TransmissionUpstreamError && err.status === 502,
    );
  });

  it("throws TransmissionUpstreamError with status 502 when the body is not JSON", async () => {
    globalThis.fetch = async () =>
      new Response("<html>bad gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });

    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });

    await assert.rejects(
      () => client.getSessionStats(),
      (err: unknown) =>
        err instanceof TransmissionUpstreamError && err.status === 502,
    );
    await assert.rejects(
      () => client.listTorrents(["id"]),
      (err: unknown) =>
        err instanceof TransmissionUpstreamError && err.status === 502,
    );
  });

  it("throws TransmissionUpstreamError when getSessionStats gets success with no arguments object", async () => {
    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });

    globalThis.fetch = async () => jsonResponse(200, { result: "success" });
    await assert.rejects(
      () => client.getSessionStats(),
      (err: unknown) =>
        err instanceof TransmissionUpstreamError && err.status === 502,
    );

    globalThis.fetch = async () =>
      jsonResponse(200, { result: "success", arguments: null });
    await assert.rejects(
      () => client.getSessionStats(),
      (err: unknown) =>
        err instanceof TransmissionUpstreamError && err.status === 502,
    );
  });

  it("throws TransmissionUpstreamError when listTorrents gets success with no arguments object", async () => {
    const client = createTransmissionClient({
      baseUrl: "http://transmission:9091",
    });

    globalThis.fetch = async () => jsonResponse(200, { result: "success" });
    await assert.rejects(
      () => client.listTorrents(["id"]),
      (err: unknown) =>
        err instanceof TransmissionUpstreamError && err.status === 502,
    );

    globalThis.fetch = async () =>
      jsonResponse(200, { result: "success", arguments: "nope" });
    await assert.rejects(
      () => client.listTorrents(["id"]),
      (err: unknown) =>
        err instanceof TransmissionUpstreamError && err.status === 502,
    );
  });
});
