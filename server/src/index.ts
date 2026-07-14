import express from "express";
import path from "path";
import { loadConfig, type AppConfig } from "./config";
import { createPlexClient } from "./plex/client";
import { createAuthRouter } from "./routes/auth";

loadLocalEnvFile();

let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const plex = createPlexClient({
  clientId: config.plexClientId,
  product: config.plexProduct,
});

const app = express();

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", createAuthRouter(plex));

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
