import express from "express";
import path from "path";
import { loadConfig, type AppConfig } from "./config";
import { createDashboardClient } from "./dashboard/client";
import { requireAdmin, requireAuth } from "./middleware/auth";
import { createPlexClient } from "./plex/client";
import { createPlexServerClient } from "./plex/server";
import { createAdminRouter } from "./routes/admin";
import { createAuthRouter } from "./routes/auth";
import { createDiscoverRouter } from "./routes/discover";
import { createIssuesRouter } from "./routes/issues";
import { createMeRouter } from "./routes/me";
import { createRequestsRouter } from "./routes/requests";
import { createWatchlistRouter } from "./routes/watchlist";
import { createSeerrClient } from "./seerr/client";
import { createMediaStatusProvider } from "./seerr/mediaStatusProvider";
import { createTmdbClient } from "./tmdb/client";
import { createMediaEnrichment } from "./tmdb/enrichment";

loadLocalEnvFile();

let config: AppConfig;
try {
  config = loadConfig();
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
const mediaStatus = createMediaStatusProvider(seerr);

const dashboard = createDashboardClient({
  baseUrl: config.dashboardUrl,
});

const tmdb = createTmdbClient({
  apiKey: config.tmdbApiKey,
});
const mediaEnrichment = createMediaEnrichment(tmdb);

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
  createDiscoverRouter({ tmdb, mediaStatus }),
);

app.use(
  "/api/watchlist",
  requireAuth(config.sessionSecret),
  createWatchlistRouter({ seerr, mediaStatus, mediaEnrichment }),
);

app.use(
  "/api/issues",
  requireAuth(config.sessionSecret),
  createIssuesRouter({ seerr, mediaStatus, mediaEnrichment }),
);

app.use(
  "/api/requests",
  requireAuth(config.sessionSecret),
  createRequestsRouter({
    seerr,
    tmdb,
    sessionSecret: config.sessionSecret,
  }),
);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "not found" });
});

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
