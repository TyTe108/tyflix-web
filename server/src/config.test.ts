import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "./config";

const validEnv = {
  PORT: "4000",
  NODE_ENV: "production",
  PLEX_CLIENT_ID: "plex-client-id",
  PLEX_PRODUCT: "CustomProduct",
  PLEX_BASEURL: "http://plex:32400",
  PLEX_TOKEN: "plex-token",
  SESSION_SECRET: "sixteen-chars!!!",
  SEERR_URL: "http://seerr:5055",
  SEERR_API_KEY: "seerr-api-key",
  DASHBOARD_URL: "http://dashboard:8787",
  TMDB_API_KEY: "tmdb-api-key",
  RADARR_URL: "http://radarr:7878",
  RADARR_API_KEY: "radarr-api-key",
  RADARR_QUALITY_PROFILE_ID: "4",
  RADARR_ROOT_FOLDER: "/movies",
  SONARR_URL: "http://sonarr:8989",
  SONARR_API_KEY: "sonarr-api-key",
  SONARR_QUALITY_PROFILE_ID: "5",
  SONARR_ROOT_FOLDER: "/tv",
};

describe("loadConfig", () => {
  it("parses a complete valid env object", () => {
    const config = loadConfig(validEnv);
    assert.deepEqual(config, {
      port: 4000,
      nodeEnv: "production",
      plexClientId: "plex-client-id",
      plexProduct: "CustomProduct",
      plexBaseUrl: "http://plex:32400",
      plexToken: "plex-token",
      sessionSecret: "sixteen-chars!!!",
      seerrUrl: "http://seerr:5055",
      seerrApiKey: "seerr-api-key",
      dashboardUrl: "http://dashboard:8787",
      dbPath: path.resolve("./data/tyflix.db"),
      tmdbApiKey: "tmdb-api-key",
      radarrUrl: "http://radarr:7878",
      radarrApiKey: "radarr-api-key",
      radarrQualityProfileId: 4,
      radarrRootFolder: "/movies",
      radarrMinimumAvailability: "released",
      sonarrUrl: "http://sonarr:8989",
      sonarrApiKey: "sonarr-api-key",
      sonarrQualityProfileId: 5,
      sonarrRootFolder: "/tv",
      sonarrLanguageProfileId: null,
    });
  });

  it("strips trailing slashes from DASHBOARD_URL", () => {
    const config = loadConfig({
      ...validEnv,
      DASHBOARD_URL: "http://dashboard:8787///",
    });
    assert.equal(config.dashboardUrl, "http://dashboard:8787");
  });

  it("throws naming DASHBOARD_URL when missing or empty", () => {
    assert.throws(
      () => loadConfig({ ...validEnv, DASHBOARD_URL: undefined }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("DASHBOARD_URL"),
    );
    assert.throws(
      () => loadConfig({ ...validEnv, DASHBOARD_URL: "" }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("DASHBOARD_URL"),
    );
  });

  it("strips trailing slashes from PLEX_BASEURL", () => {
    const config = loadConfig({
      ...validEnv,
      PLEX_BASEURL: "http://plex:32400///",
    });
    assert.equal(config.plexBaseUrl, "http://plex:32400");
  });

  it("throws naming PLEX_BASEURL when missing or empty", () => {
    assert.throws(
      () => loadConfig({ ...validEnv, PLEX_BASEURL: undefined }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("PLEX_BASEURL"),
    );
    assert.throws(
      () => loadConfig({ ...validEnv, PLEX_BASEURL: "" }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("PLEX_BASEURL"),
    );
  });

  it("throws naming PLEX_TOKEN when missing or empty", () => {
    assert.throws(
      () => loadConfig({ ...validEnv, PLEX_TOKEN: undefined }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("PLEX_TOKEN"),
    );
    assert.throws(
      () => loadConfig({ ...validEnv, PLEX_TOKEN: "  " }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("PLEX_TOKEN"),
    );
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

  it('defaults DB_PATH to "./data/tyflix.db" as an absolute path', () => {
    const config = loadConfig(validEnv);
    assert.equal(config.dbPath, path.resolve("./data/tyflix.db"));
  });

  it("resolves relative DB_PATH against cwd", () => {
    const config = loadConfig({
      ...validEnv,
      DB_PATH: "./custom/tyflix.db",
    });
    assert.equal(config.dbPath, path.resolve("./custom/tyflix.db"));
  });

  it("preserves absolute DB_PATH", () => {
    const config = loadConfig({
      ...validEnv,
      DB_PATH: "/var/data/tyflix.db",
    });
    assert.equal(config.dbPath, "/var/data/tyflix.db");
  });

  it("throws naming TMDB_API_KEY when missing or empty", () => {
    assert.throws(
      () => loadConfig({ ...validEnv, TMDB_API_KEY: undefined }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("TMDB_API_KEY"),
    );
    assert.throws(
      () => loadConfig({ ...validEnv, TMDB_API_KEY: "" }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("TMDB_API_KEY"),
    );
  });

  it("strips trailing slashes from RADARR_URL and SONARR_URL", () => {
    const config = loadConfig({
      ...validEnv,
      RADARR_URL: "http://radarr:7878///",
      SONARR_URL: "http://sonarr:8989///",
    });
    assert.equal(config.radarrUrl, "http://radarr:7878");
    assert.equal(config.sonarrUrl, "http://sonarr:8989");
  });

  it("defaults RADARR_MINIMUM_AVAILABILITY to released", () => {
    const config = loadConfig(validEnv);
    assert.equal(config.radarrMinimumAvailability, "released");
  });

  it("parses optional SONARR_LANGUAGE_PROFILE_ID", () => {
    const withId = loadConfig({
      ...validEnv,
      SONARR_LANGUAGE_PROFILE_ID: "2",
    });
    assert.equal(withId.sonarrLanguageProfileId, 2);
    const without = loadConfig(validEnv);
    assert.equal(without.sonarrLanguageProfileId, null);
  });

  it("throws naming RADARR_URL when missing or empty", () => {
    assert.throws(
      () => loadConfig({ ...validEnv, RADARR_URL: undefined }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("RADARR_URL"),
    );
  });

  it("throws naming SONARR_API_KEY when missing or empty", () => {
    assert.throws(
      () => loadConfig({ ...validEnv, SONARR_API_KEY: undefined }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("SONARR_API_KEY"),
    );
  });
});
