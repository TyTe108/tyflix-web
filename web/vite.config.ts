import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/healthz": "http://localhost:4000",
    },
  },
  // Component tests share this Vite config rather than a separate
  // vitest.config.ts. The environment is jsdom; production code stays on the
  // real browser via `vite` / `vite build`.
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
