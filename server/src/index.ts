import express from "express";
import path from "path";
import { loadConfig, type AppConfig } from "./config";

let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const app = express();

app.get("/healthz", (_req, res) => {
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
