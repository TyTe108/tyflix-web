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
  const server = app.listen(0);
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
