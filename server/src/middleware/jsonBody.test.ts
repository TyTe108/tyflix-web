// Tests the JSON request-body parser mounted in index.ts immediately after
// Helmet. Compressed request-body inflation is disabled there to avoid the
// request-side paths implicated by CVE-2026-111497 and CVE-2026-111181.

import assert from "node:assert/strict";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import express from "express";
import { jsonBody } from "./jsonBody";

function buildApp(): { app: express.Express; getHandlerRuns: () => number } {
  const app = express();
  let handlerRuns = 0;

  app.use(jsonBody);
  app.post("/echo", (req, res) => {
    handlerRuns += 1;
    res.json({ body: req.body });
  });

  return { app, getHandlerRuns: () => handlerRuns };
}

async function postJson(
  app: express.Express,
  body: BodyInit | null,
  contentEncoding?: string,
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const headers = new Headers({ "Content-Type": "application/json" });
    if (contentEncoding !== undefined) {
      headers.set("Content-Encoding", contentEncoding);
    }

    return await fetch(`http://127.0.0.1:${address.port}/echo`, {
      method: "POST",
      headers,
      body,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("JSON request-body parser", () => {
  for (const [encoding, compress] of [
    ["br", brotliCompressSync],
    ["gzip", gzipSync],
    ["deflate", deflateSync],
  ] as const) {
    it(`refuses a ${encoding}-compressed JSON body before the route handler`, async () => {
      const { app, getHandlerRuns } = buildApp();
      const response = await postJson(
        app,
        compress(Buffer.from(JSON.stringify({ source: encoding }))),
        encoding,
      );

      assert.equal(response.status, 415);
      assert.equal(getHandlerRuns(), 0);
    });
  }

  it("refuses an unknown content encoding before the route handler", async () => {
    const { app, getHandlerRuns } = buildApp();
    const response = await postJson(
      app,
      JSON.stringify({ source: "unknown" }),
      "x-foo",
    );

    assert.equal(response.status, 415);
    assert.equal(getHandlerRuns(), 0);
  });

  for (const [name, contentEncoding] of [
    ["no Content-Encoding", undefined],
    ["Content-Encoding: identity", "identity"],
  ] as const) {
    it(`parses an uncompressed JSON body with ${name}`, async () => {
      const { app, getHandlerRuns } = buildApp();
      const response = await postJson(
        app,
        JSON.stringify({ source: name }),
        contentEncoding,
      );

      assert.equal(response.status, 200);
      assert.equal(getHandlerRuns(), 1);
      assert.deepEqual(await response.json(), { body: { source: name } });
    });
  }

  it("leaves an empty JSON body unchanged", async () => {
    const { app, getHandlerRuns } = buildApp();
    const response = await postJson(app, null);

    assert.equal(response.status, 200);
    assert.equal(getHandlerRuns(), 1);
    assert.deepEqual(await response.json(), { body: {} });
  });
});
