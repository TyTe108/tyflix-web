import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import { createConfigRouter } from "./config";

function buildApp(
  accessRequestsEnabled: boolean,
  transmissionEnabled: boolean,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/config",
    createConfigRouter({ accessRequestsEnabled, transmissionEnabled }),
  );
  return app;
}

async function getConfig(app: express.Express): Promise<Response> {
  // On macOS a wildcard listen on port 0 can share a port another app holds on 127.0.0.1, and the request then goes to that app (HANDOFF §9).
  const server = app.listen(0, "127.0.0.1");
  // Node binds on the next tick when a host is passed, so address() is null
  // until listening fires.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      resolve();
    });
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    return await fetch(`http://127.0.0.1:${address.port}/api/config`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("GET /api/config", () => {
  it("returns accessRequestsEnabled true when the feature is on", async () => {
    const response = await getConfig(buildApp(true, false));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      accessRequestsEnabled: true,
      transmissionEnabled: false,
    });
  });

  it("returns accessRequestsEnabled false when the feature is off", async () => {
    const response = await getConfig(buildApp(false, true));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      accessRequestsEnabled: false,
      transmissionEnabled: true,
    });
  });
});
