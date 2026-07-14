import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config";

const validEnv = {
  PORT: "4000",
  NODE_ENV: "production",
  PLEX_CLIENT_ID: "plex-client-id",
  PLEX_PRODUCT: "CustomProduct",
  SESSION_SECRET: "sixteen-chars!!!",
  SEERR_URL: "http://seerr:5055",
  SEERR_API_KEY: "seerr-api-key",
};

describe("loadConfig", () => {
  it("parses a complete valid env object", () => {
    const config = loadConfig(validEnv);
    assert.deepEqual(config, {
      port: 4000,
      nodeEnv: "production",
      plexClientId: "plex-client-id",
      plexProduct: "CustomProduct",
      sessionSecret: "sixteen-chars!!!",
      seerrUrl: "http://seerr:5055",
      seerrApiKey: "seerr-api-key",
    });
  });

  it('defaults PLEX_PRODUCT to "Tyflix" and NODE_ENV to "development"', () => {
    const { PLEX_PRODUCT: _p, NODE_ENV: _n, ...rest } = validEnv;
    const config = loadConfig(rest);
    assert.equal(config.plexProduct, "Tyflix");
    assert.equal(config.nodeEnv, "development");
  });

  it("strips trailing slashes from SEERR_URL", () => {
    const config = loadConfig({
      ...validEnv,
      SEERR_URL: "http://seerr:5055///",
    });
    assert.equal(config.seerrUrl, "http://seerr:5055");
  });

  it("throws naming PLEX_CLIENT_ID when missing or empty", () => {
    assert.throws(
      () => loadConfig({ ...validEnv, PLEX_CLIENT_ID: undefined }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("PLEX_CLIENT_ID"),
    );
    assert.throws(
      () => loadConfig({ ...validEnv, PLEX_CLIENT_ID: "  " }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("PLEX_CLIENT_ID"),
    );
  });

  it("throws naming SEERR_URL when missing or empty", () => {
    assert.throws(
      () => loadConfig({ ...validEnv, SEERR_URL: undefined }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("SEERR_URL"),
    );
    assert.throws(
      () => loadConfig({ ...validEnv, SEERR_URL: "" }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("SEERR_URL"),
    );
  });

  it("throws naming SEERR_API_KEY when missing or empty", () => {
    assert.throws(
      () => loadConfig({ ...validEnv, SEERR_API_KEY: undefined }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("SEERR_API_KEY"),
    );
    assert.throws(
      () => loadConfig({ ...validEnv, SEERR_API_KEY: "" }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("SEERR_API_KEY"),
    );
  });

  it("throws naming SESSION_SECRET when shorter than 16 chars", () => {
    assert.throws(
      () => loadConfig({ ...validEnv, SESSION_SECRET: "tooshort" }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("SESSION_SECRET"),
    );
  });

  it("throws naming PORT when non-numeric or out of range", () => {
    assert.throws(
      () => loadConfig({ ...validEnv, PORT: "abc" }),
      (err: unknown) => err instanceof Error && err.message.includes("PORT"),
    );
    assert.throws(
      () => loadConfig({ ...validEnv, PORT: "0" }),
      (err: unknown) => err instanceof Error && err.message.includes("PORT"),
    );
    assert.throws(
      () => loadConfig({ ...validEnv, PORT: "65536" }),
      (err: unknown) => err instanceof Error && err.message.includes("PORT"),
    );
  });
});
