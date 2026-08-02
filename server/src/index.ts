// Composition root and routing table for the Tyflix backend. Every upstream
// client is constructed once here and handed to the routers that need it, so
// this file is the one place that knows the whole dependency graph.
//
// Startup runs in a fixed order: load the local .env (dev only), loadConfig and
// exit the process if anything's missing, then start() builds the clients,
// mounts middleware, mounts routers, and listens. Middleware order is the real
// contract. Helmet goes on first so its headers cover both JSON responses and
// the SPA, then express.json, then the /api rate limiter, then the routers, and
// finally a catch-all /api handler that returns a JSON 404 instead of letting
// an unknown API path fall through to index.html.
//
// Mount-order rules are load-bearing. Everything public (/api/auth,
// /api/config, /api/access-requests) has to be registered before that /api 404
// guard. /api/admin/media, /api/admin/blocklist, and
// /api/admin/access-requests have to come before /api/admin because Express
// matches prefixes in registration order. Note that most routers are gated by
// requireAuth/requireAdmin right here at the mount, but the admin
// access-requests router applies requireAdmin internally instead, which is why
// it looks unguarded below.
//
// In production this same process serves the built React app from
// ../../web/dist, with a splat route sending every unmatched path to index.html
// so client-side routing survives a page refresh. In development Vite serves
// the SPA and proxies /api here, so that block never runs.

import express from "express";
import helmet from "helmet";
import path from "path";
import { createAccessRequestStore } from "./accessRequests/store";
import { loadConfig, type AppConfig } from "./config";
import { createDashboardClient } from "./dashboard/client";
import { requireAdmin, requireAuth } from "./middleware/auth";
import {
  accessRequestLimiter,
  apiRateLimiter,
} from "./middleware/rateLimit";
import { createPlexClient } from "./plex/client";
import { createPlexConnectionResolver } from "./plex/connection";
import { createPlexServerClient } from "./plex/server";
import { createPlexSharingClient } from "./plex/sharing";
import { createSharedServerAccessResolver } from "./plex/sharedServerAccess";
import { createTransientTokenMinter } from "./plex/transientToken";
import { createAccessRequestsRouter } from "./routes/accessRequests";
import { createAdminAccessRequestsRouter } from "./routes/adminAccessRequests";
import { createAdminBlocklistRouter } from "./routes/adminBlocklist";
import { createAdminMediaRouter } from "./routes/adminMedia";
import { createAdminRouter } from "./routes/admin";
import { createAuthRouter } from "./routes/auth";
import { createConfigRouter } from "./routes/config";
import { createDiscoverRouter } from "./routes/discover";
import { createLibraryRouter } from "./routes/library";
import { createIssuesRouter } from "./routes/issues";
import { createMeRouter } from "./routes/me";
import { createRequestsRouter } from "./routes/requests";
import { createWatchRouter } from "./routes/watch";
import { createWatchlistRouter } from "./routes/watchlist";
import { createSeerrClient } from "./seerr/client";
import { createMediaStatusProvider } from "./seerr/mediaStatusProvider";
import { createSessionRevocationStore } from "./sessionRevocation";
import { createSonarrClient } from "./sonarr/client";
import { createTmdbClient } from "./tmdb/client";
import { createMediaEnrichment } from "./tmdb/enrichment";

loadLocalEnvFile();

// Config is validated before anything else is built, so a missing or malformed
// env var kills the process at boot rather than showing up as a 500 on the
// first request that happens to need it.
let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

// There's nothing to recover to if wiring or listen() fails, so log the message
// and exit non-zero.
void start().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

// Builds the upstream clients, mounts everything in order, then listens. Async
// because the JSON-file stores read at construction.
async function start(): Promise<void> {
  // Always constructed — session revocation is core auth, not feature-flagged.
  // Boot fails loud if SESSION_REVOCATION_FILE's parent directory is missing.
  const sessionRevocation = await createSessionRevocationStore(
    config.sessionRevocationFile,
  );

  // Self-serve access requests are off unless ACCESS_REQUESTS_FILE points at a
  // real path. An undefined store here is the single feature flag: it gates the
  // public submit route, gates the admin queue, and is what /api/config reports
  // back to the SPA so the UI doesn't advertise a route that isn't mounted.
  const accessRequestStore =
    config.accessRequestsFile !== undefined
      ? await createAccessRequestStore(config.accessRequestsFile)
      : undefined;

  // Session cookies only get the Secure flag in production. Dev runs over plain
  // HTTP, where a Secure cookie wouldn't be sent back at all.
  const secureCookies = config.nodeEnv === "production";

  // Five Plex-facing clients, split by which credential each one carries.
  // `plex` talks to plex.tv with no token, since it's what drives the PIN
  // sign-in flow. The next three hold the owner token from config. The
  // transient minter holds no token either; callers pass the user's own token
  // per call and get a short-lived one back. A sixth, the sharing client, gets
  // built further down and only when access requests are turned on.
  const plex = createPlexClient({
    clientId: config.plexClientId,
    product: config.plexProduct,
  });

  const plexServer = createPlexServerClient({
    baseUrl: config.plexBaseUrl,
    token: config.plexToken,
  });

  const plexConnection = createPlexConnectionResolver({
    baseUrl: config.plexBaseUrl,
    token: config.plexToken,
    clientId: config.plexClientId,
  });

  const sharedServerAccess = createSharedServerAccessResolver({
    baseUrl: config.plexBaseUrl,
    ownerToken: config.plexToken,
    clientId: config.plexClientId,
  });

  const transientMinter = createTransientTokenMinter({
    baseUrl: config.plexBaseUrl,
    clientId: config.plexClientId,
  });

  // Seerr is both the request pipeline into Radarr/Sonarr and the join table
  // between TMDB ids and Plex rating keys. mediaStatus wraps it with a cached
  // lookup so the discovery grids can ask "is this on the server already?"
  // without a round trip per poster.
  const seerr = createSeerrClient({
    baseUrl: config.seerrUrl,
    apiKey: config.seerrApiKey,
  });
  const mediaStatus = createMediaStatusProvider(seerr);
  const sonarr = createSonarrClient({
    baseUrl: config.sonarrUrl,
    apiKey: config.sonarrApiKey,
  });

  // Host metrics service behind the admin dashboard: CPU, memory, storage, GPU.
  const dashboard = createDashboardClient({
    baseUrl: config.dashboardUrl,
  });

  // TMDB supplies discovery metadata and poster art. mediaEnrichment is the
  // reverse direction: hydrating a bare TMDB id from Seerr into something with
  // a title and artwork.
  const tmdb = createTmdbClient({
    apiKey: config.tmdbApiKey,
  });
  const mediaEnrichment = createMediaEnrichment(tmdb);

  // External hosts the SPA legitimately loads from; allowlisted in the CSP below.
  const GOOGLE_FONTS_STYLESHEET_ORIGIN = "https://fonts.googleapis.com";
  const GOOGLE_FONTS_FILE_ORIGIN = "https://fonts.gstatic.com";
  const TMDB_IMAGE_ORIGIN = "https://image.tmdb.org";
  // Plex's direct-connection hosts (…plex.direct:32400) the browser streams HLS
  // from — needed for both the manifest fetch (connect-src) and playback (media-src).
  const PLEX_DIRECT_ORIGIN = "https://*.plex.direct:32400";
  // Google Cast Application Framework (CAF) web sender SDK + its injected iframe.
  const GSTATIC_ORIGIN = "https://www.gstatic.com";

  const app = express();

  // Baseline security headers. Mounted first so they apply to both /api responses
  // and the production SPA (static assets + index.html fallback).
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'", GSTATIC_ORIGIN],
          "style-src": ["'self'", "'unsafe-inline'", GOOGLE_FONTS_STYLESHEET_ORIGIN],
          "font-src": ["'self'", GOOGLE_FONTS_FILE_ORIGIN],
          "img-src": ["'self'", "data:", TMDB_IMAGE_ORIGIN, PLEX_DIRECT_ORIGIN],
          "connect-src": ["'self'", PLEX_DIRECT_ORIGIN, GSTATIC_ORIGIN],
          "media-src": ["'self'", "blob:", PLEX_DIRECT_ORIGIN],
          "object-src": ["'none'"],
          "base-uri": ["'self'"],
          "frame-src": ["'self'", GSTATIC_ORIGIN],
          "frame-ancestors": ["'none'"],
        },
      },
      // The Plex login popup relies on the opener keeping a handle to call
      // popup.close(); the stricter "same-origin" default can sever that.
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      // Leave COEP off — enabling it would block TMDB images and Google Fonts.
      crossOriginEmbedderPolicy: false,
    }),
  );

  // JSON bodies only. There's deliberately no cookie-parser: session.ts reads
  // the Cookie header itself, so the session format stays in one file.
  app.use(express.json());

  // Liveness probe, outside /api so the rate limiter never counts it. Vite
  // proxies this path in dev alongside /api.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Blanket limiter for the API surface, keyed on the real client IP rather
  // than the tunnel's. Mounted before any router so a flood can't reach an
  // upstream. See middleware/rateLimit.ts for why the key isn't req.ip.
  app.use("/api", apiRateLimiter);

  // Unauthenticated by definition: this router runs the Plex PIN handshake and
  // is what mints the session cookie in the first place.
  app.use(
    "/api/auth",
    createAuthRouter({
      plex,
      seerr,
      sessionSecret: config.sessionSecret,
      secureCookies,
      sessionRevocation,
    }),
  );

  // Public feature-flag probe (no secrets). Always mounted so the SPA can
  // learn whether optional public flows are available while logged out.
  app.use(
    "/api/config",
    createConfigRouter({
      accessRequestsEnabled: accessRequestStore !== undefined,
    }),
  );

  // Public, unauthenticated — same unguarded precedent as /api/auth. Must be
  // mounted before the /api 404 guard below.
  if (accessRequestStore !== undefined) {
    app.use(
      "/api/access-requests",
      accessRequestLimiter,
      createAccessRequestsRouter({ store: accessRequestStore }),
    );
  }

  // First guarded mount. Everything from here down reads the caller's identity
  // out of res.locals.session, which requireAuth puts there.
  app.use(
    "/api/me",
    requireAuth(config.sessionSecret, seerr, sessionRevocation),
    createMeRouter({ plexServer, seerr }),
  );

  // More specific than /api/admin — mount first. requireAdmin at the mount so
  // every media-removal route is gated; this router deletes files.
  app.use(
    "/api/admin/media",
    requireAdmin(config.sessionSecret, seerr, sessionRevocation),
    createAdminMediaRouter({ seerr, sonarr, mediaStatus, mediaEnrichment }),
  );

  // More specific than /api/admin — mount before it. requireAdmin at the mount;
  // handlers also check isAdmin themselves.
  app.use(
    "/api/admin/blocklist",
    requireAdmin(config.sessionSecret, seerr, sessionRevocation),
    createAdminBlocklistRouter({ seerr, mediaEnrichment }),
  );

  // More specific than /api/admin — mount before it. Same ACCESS_REQUESTS_FILE
  // gate as the public submit route.
  //
  // No requireAdmin here on purpose: createAdminAccessRequestsRouter builds its
  // own requireAdmin from sessionSecret and applies it per route.
  if (accessRequestStore !== undefined) {
    const sharing = createPlexSharingClient({
      baseUrl: config.plexBaseUrl,
      ownerToken: config.plexToken,
      clientId: config.plexClientId,
    });
    app.use(
      "/api/admin/access-requests",
      createAdminAccessRequestsRouter({
        store: accessRequestStore,
        sharing,
        sessionSecret: config.sessionSecret,
        seerr,
        sessionRevocation,
      }),
    );
  }

  // requireAdmin, not requireAuth: it checks the Seerr admin permission bit on
  // top of a valid session.
  app.use(
    "/api/admin",
    requireAdmin(config.sessionSecret, seerr, sessionRevocation),
    createAdminRouter({ dashboard }),
  );

  // Discovery is TMDB data with Plex availability layered over it, which is the
  // TMDB-id-to-rating-key join happening in mediaStatus.
  app.use(
    "/api/discover",
    requireAuth(config.sessionSecret, seerr, sessionRevocation),
    createDiscoverRouter({ tmdb, mediaStatus }),
  );

  // Library browses the Plex sections directly, no TMDB involved. It takes
  // sessionSecret because it needs to decrypt the caller's own Plex token to
  // read per-user watch state, and sharedServerAccess to swap in the per-server
  // token for shared accounts.
  app.use(
    "/api/library",
    requireAuth(config.sessionSecret, seerr, sessionRevocation),
    createLibraryRouter({
      plexServer,
      sharedServerAccess,
      sessionSecret: config.sessionSecret,
    }),
  );

  // Watchlist and issues are both Seerr-backed lists of bare TMDB ids, so they
  // take the same pair: mediaStatus for availability, mediaEnrichment for the
  // title and poster.
  app.use(
    "/api/watchlist",
    requireAuth(config.sessionSecret, seerr, sessionRevocation),
    createWatchlistRouter({ seerr, mediaStatus, mediaEnrichment }),
  );

  app.use(
    "/api/issues",
    requireAuth(config.sessionSecret, seerr, sessionRevocation),
    createIssuesRouter({ seerr, mediaStatus, mediaEnrichment }),
  );

  app.use(
    "/api/requests",
    requireAuth(config.sessionSecret, seerr, sessionRevocation),
    createRequestsRouter({
      seerr,
      tmdb,
      sessionSecret: config.sessionSecret,
      sessionRevocation,
    }),
  );

  // Playback. This is the widest dependency set in the file because a play
  // decision needs the right token for this user on this server, a browser
  // reachable plex.direct address, and the rating key behind a TMDB id.
  app.use(
    "/api/watch",
    requireAuth(config.sessionSecret, seerr, sessionRevocation),
    createWatchRouter({
      plexConnection,
      transientMinter,
      mediaStatus,
      plexServer,
      sharedServerAccess,
      sessionSecret: config.sessionSecret,
      plexClientId: config.plexClientId,
    }),
  );

  // Terminal guard for the API namespace. Without it, an unknown /api path
  // would fall through to the SPA fallback below and answer a fetch() with a
  // 200 and a page of HTML, which is a miserable thing to debug.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // Production only: serve the built React app from the same origin. __dirname
  // is server/dist at runtime, so this lands on web/dist next to it, both in
  // the container image and in a local build. In dev, Vite serves the SPA and
  // proxies /api back here, so none of this is mounted.
  if (config.nodeEnv === "production") {
    const webDistPath = path.resolve(__dirname, "../../web/dist");

    // Static assets first, then the splat route hands every remaining path
    // index.html so a deep link like /library/movies survives a refresh. The
    // "/{*path}" spelling is Express 5's named splat, which replaced the bare
    // "*" that worked in Express 4.
    app.use(express.static(webDistPath));
    app.get("/{*path}", (_req, res) => {
      res.sendFile(path.join(webDistPath, "index.html"));
    });
  }

  app.listen(config.port, () => {
    console.log(`server listening on port ${config.port} (${config.nodeEnv})`);
  });
}

// Dev convenience: pull the repo-root .env into process.env before loadConfig
// reads it. Production gets its env from the container instead, so this bails
// out before touching the filesystem at all.
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
