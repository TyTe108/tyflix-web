import express from "express";
import path from "path";
import { loadConfig, type AppConfig } from "./config";
import { createDashboardClient } from "./dashboard/client";
import { openDatabase } from "./db";
import { requireAdmin, requireAuth } from "./middleware/auth";
import { createPlexClient } from "./plex/client";
import { createPlexServerClient } from "./plex/server";
import { createRadarrClient } from "./radarr/client";
import { createAdminRouter } from "./routes/admin";
import { createAuthRouter } from "./routes/auth";
import { createDiscoverRouter } from "./routes/discover";
import { createMeRouter } from "./routes/me";
import { createRequestsRouter } from "./routes/requests";
import { createSeerrClient } from "./seerr/client";
import { createSonarrClient } from "./sonarr/client";
import { createTmdbClient } from "./tmdb/client";

loadLocalEnvFile();

let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

try {
  openDatabase(config.dbPath);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const secureCookies = config.nodeEnv === "production";

const plex = createPlexClient({
  clientId: config.plexClientId,
  product: config.plexProduct,
});

const plexServer = createPlexServerClient({
  baseUrl: config.plexBaseUrl,
  token: config.plexToken,
});

const seerr = createSeerrClient({
  baseUrl: config.seerrUrl,
  apiKey: config.seerrApiKey,
});

const dashboard = createDashboardClient({
  baseUrl: config.dashboardUrl,
});

const tmdb = createTmdbClient({
  apiKey: config.tmdbApiKey,
});

const radarr = createRadarrClient({
  url: config.radarrUrl,
  apiKey: config.radarrApiKey,
});

const sonarr = createSonarrClient({
  url: config.sonarrUrl,
  apiKey: config.sonarrApiKey,
});

const requestsConfig = {
  radarrQualityProfileId: config.radarrQualityProfileId,
  radarrRootFolder: config.radarrRootFolder,
  radarrMinimumAvailability: config.radarrMinimumAvailability,
  sonarrQualityProfileId: config.sonarrQualityProfileId,
  sonarrRootFolder: config.sonarrRootFolder,
  sonarrLanguageProfileId: config.sonarrLanguageProfileId,
};

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.use(
  "/api/auth",
  createAuthRouter({
    plex,
    seerr,
    sessionSecret: config.sessionSecret,
    secureCookies,
  }),
);

app.use(
  "/api/me",
  requireAuth(config.sessionSecret),
  createMeRouter({ plexServer, seerr }),
);

app.use(
  "/api/admin",
  requireAdmin(config.sessionSecret),
  createAdminRouter({ dashboard }),
);

app.use(
  "/api/discover",
  requireAuth(config.sessionSecret),
  createDiscoverRouter({ tmdb }),
);

app.use(
  "/api/requests",
  requireAuth(config.sessionSecret),
  createRequestsRouter({
    tmdb,
    radarr,
    sonarr,
    config: requestsConfig,
    sessionSecret: config.sessionSecret,
  }),
);

if (config.nodeEnv === "production") {
  const webDistPath = path.resolve(__dirname, "../../web/dist");

  app.use(express.static(webDistPath));
  app.get("/{*path}", (_req, res) => {
    res.sendFile(path.join(webDistPath, "index.html"));
  });
}

app.listen(config.port, () => {
  console.log(`server listening on port ${config.port} (${config.nodeEnv})`);
});

function loadLocalEnvFile(): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }
  try {
    process.loadEnvFile(path.resolve(__dirname, "../../.env"));
  } catch {
    // Missing .env is fine in development.
  }
}
