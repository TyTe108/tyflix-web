import express from "express";
import path from "path";
import { loadConfig, type AppConfig } from "./config";
import { requireAdmin, requireAuth } from "./middleware/auth";
import { createPlexClient } from "./plex/client";
import { createPlexServerClient } from "./plex/server";
import { createAuthRouter } from "./routes/auth";
import { createMeRouter } from "./routes/me";
import { createSeerrClient } from "./seerr/client";

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

const app = express();

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

// Temporary gate-verification probe; replaced by real admin routes in Phase 3.
app.get("/api/admin/ping", requireAdmin(config.sessionSecret), (_req, res) => {
  res.json({ ok: true });
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
