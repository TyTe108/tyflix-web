# Tyflix Web — Project Handoff Document

> Living doc. Its job is to let a fresh conversation pick up this project cold.
> Keep it current; delete guidance notes as you go.
>
> **Last updated after:** Phase 3.4 — Phase 3 (admin dashboard, all four panels) complete. Next: Phase 4 (deploy).
> **Working name:** "Tyflix Web" / repo `tyflix-web` — rename freely.

---

## 1. Project identity

- **What it is:** A self-hosted web app for the Tyflix media stack that puts an
  expanded, analytics-rich layer behind a Plex login. Regular users see their own
  **watched-vs-requested** stats; admins additionally see everything the existing
  **Tyflix Admin Dashboard** shows (system/GPU/storage/jobs/containers + per-user
  analytics).
- **Who it's for:** Tyler (owner/admin) and the Plex users who share the Tyflix
  server. Publicly reachable, so treat every non-owner as untrusted.
- **Product intent:** Start as a **standalone companion** to Jellyseerr (Seerr keeps
  handling browse/request; we add the analytics + login). Architect so it can grow
  into a **full Seerr replacement** later (own request pipeline, TMDB browse, etc.).
- **Developer:** Tyler (solo). **Integration point** — runs the coding agent, smoke-tests, commits.
- **Workflow:** Cursor writes the code; Claude plans and reviews; Tyler runs Cursor,
  pastes real file contents back for review, smoke-tests, then commits. Nothing is
  committed before a manual smoke test.
- **Repository:** TBD. Suggested: new git repo `tyflix-web`, cloned as a nested dir
  inside the `Home Media Server` workspace and gitignored by the outer docs repo —
  matching the established pattern (`dashboard/`, `seerr/`, `iso-converter/`).

## 2. Tech stack

- **Backend:** Node.js (LTS 20+) + TypeScript, Express. Session-based auth (own signed
  cookie). `undici`/`fetch` for upstream HTTP.
- **Frontend:** React + TypeScript, built with Vite. Router: React Router. Data
  fetching: TanStack Query (or plain fetch to start).
- **Package manager:** npm (matches the Reverse-Invoke repo). Monorepo with `server/`
  and `web/` workspaces, or two sibling packages — decide in Phase 0.
- **Deploy target:** Docker container on the Dell (`<SERVER_LAN_IP>`), added to the
  existing compose set. Exposed publicly via the **Cloudflare tunnel** (new hostname,
  e.g. `tyflix.tylerte.dev` — TBD), alongside `seerr.tylerte.dev`.
- **Non-obvious:** The build must run on the Dell's Docker (Ubuntu 26.04, engine 29.x +
  compose v2). No dependency on the Mac mini (retired). Keep the image small; multi-stage
  build (build web → serve static from the Node server, or a separate static step).

## 3. Architecture

Three layers, one deployable:

```
Browser (React SPA)
   │  our own session cookie (httpOnly, Secure, SameSite=Lax)
   ▼
Node/Express backend  ── server-to-server, secrets never leave here ──►  Plex API      (auth: PIN flow + who-am-I)
   │                                                                     Seerr API      (identity/permissions + requests/users)
   │                                                                     Admin Dashboard JSON API (host metrics)  [proxied]
   ▼
Static React build served by the same Node process (single origin)
```

- **Auth layer (Phase 1):** Plex OAuth PIN flow → Plex confirms *who* the user is →
  we look the user up in **Seerr** to get their `permissions` → we mint **our own**
  session cookie. `isAdmin = (permissions & Permission.ADMIN) !== 0`, i.e. `& 2`.
- **User data layer (Phase 2):** For the logged-in user only, compute watched-vs-requested
  by joining that user's Seerr requests to Plex watch history. Logic ported from the
  Python dashboard's `build_user_report` (see §6).
- **Admin data layer (Phase 3):** Admin-only. Recommended: **proxy** the existing
  FastAPI dashboard's `/api/system`, `/api/users`, `/api/jobs`, `/api/containers` rather
  than re-implement host `/proc`, cgroup, GPU-sampler, and docker-socket-proxy plumbing
  in Node. Re-present that data in the React admin UI. (Tradeoff in §5 quirks.)

### Security / trust model

- Public exposure + admin data ⇒ **every** `/api/admin/*` route is gated server-side by
  `isAdmin`; the client is never trusted. Regular users can only ever read their own stats.
- Secrets (Seerr API key, a Plex client identifier, session signing secret, dashboard URL)
  live **only** in the backend env (`.env`, mode 600 on the Dell), never shipped to the browser.
- The Plex `authToken` is handled server-side during login and **not** persisted to the
  browser; only our opaque session cookie is.
- Defense-in-depth (deferred, candidate): Cloudflare Access in front of `/admin` routes.

## 4. File layout (current as of Phase 1; test files + web pages now exist)

```
tyflix-web/
  server/
    src/
      index.ts            # Express app bootstrap, static serving, route mounting
      config.ts           # env parsing + fail-loud on missing required vars
      session.ts          # signed-cookie session issue/verify
      plex/               # PIN flow: create pin, poll pin, get user (/api/v2/user)
      seerr/              # Seerr API client (auth/lookup, users, requests)
      routes/
        auth.ts           # /api/auth/plex/start, /check, /api/auth/me, /logout
        me.ts             # /api/me/stats           (Phase 2)
        admin.ts          # /api/admin/*  (proxy dashboard) (Phase 3)
      analytics/          # ported watched-vs-requested join (Phase 2)
  web/
    src/
      main.tsx, App.tsx
      api/                # typed client for our backend
      auth/               # login page, PIN popup, session context, ProtectedRoute
      pages/              # UserDashboard, AdminDashboard
  Dockerfile
  docker-compose.snippet.yml   # to merge into the Dell stack (Phase 4)
  .env.example
  docs/
    HANDOFF.md            # this file
    phase-1-auth-spec.md
```

## 5. External interfaces

### Plex API (auth)
- `POST https://clients.plex.tv/api/v2/pins` — headers `X-Plex-Client-Identifier`,
  `X-Plex-Product`, `X-Plex-Version`; optional `strong=true`. Returns `{ id, code }`.
- User authorizes at `https://app.plex.tv/auth#?clientID=<cid>&code=<code>&context[device][product]=<product>`.
- `GET https://clients.plex.tv/api/v2/pins/<id>` — same client-id header; poll until
  `authToken` is non-null.
- `GET https://plex.tv/api/v2/user` — header `X-Plex-Token: <authToken>` (+ client-id).
  Returns the Plex account `{ id, username, email, thumb, ... }`. This `id` is the
  **plex.tv global account id** — matches Seerr's `user.plexId`.

### Seerr API (identity + data) — base `http://seerr:5055` on the `seerr_default` docker network
- Auth via `X-Api-Key: <SEERR_API_KEY>` header (server-to-server; the dashboard already does this).
- `GET /api/v1/status` — liveness.
- `GET /api/v1/user?take=&skip=&sort=` — user records incl. `id`, `plexId`, `plexUsername`,
  `displayName`, `email`, **`permissions`** (bitmask). Look up the logged-in user by `plexId`.
- `GET /api/v1/request?take=&skip=&filter=all&sort=added` — requests; each carries
  `requestedBy.id`, `type`, `media.status`, **`media.ratingKey`**, `seasons[]`.
- `POST /api/v1/auth/plex { authToken }` — Seerr's own Plex sign-in; sets `connect.sid`.
  We generally prefer the API-key + `plexId` lookup over this (see quirks), but it's the
  canonical membership check if we want Seerr to be the sole gate.
- **Permissions:** `Permission.ADMIN = 2`. Full enum + `hasPermission` semantics in
  `server/lib/permissions.ts` (seerr-team/seerr). Any ADMIN-bit user passes all checks.

### Tyflix Admin Dashboard JSON API (host metrics) — `http://<SERVER_LAN_IP>:8787` (LAN)
- `GET /api/system` — CPU/RAM/load/uptime/temps/GPU/storage/service-health.
- `GET /api/users` — per-user watched-vs-requested rows + totals (already computed).
- `GET /api/jobs` — cron/service jobs w/ schedule, last/next run, status.
- `GET /api/containers` — docker containers + native systemd services stats.
- Phase 3 proxies these behind our admin gate. Source of truth for the exact shapes is
  the dashboard's `app/main.py` (in `Home Media Server/dashboard/`).

### Known quirks and surprises  ← the point of this section; add to it as you learn

- **Two different Plex id spaces — do not conflate.** `/api/v2/user.id` (used for login)
  is the **plex.tv global account id** and matches Seerr `user.plexId`. The watch-history
  join instead uses Plex's **local history `accountID`**, where the server **owner is
  `accountID 1`** (and is reached by a username fallback, not by plexId). Login matching
  and watch-history matching use different keys.
- **Requests carry the Plex `ratingKey` directly** (`media.ratingKey`), so requests join to
  Plex watch history with **no TMDB matching**. Big simplifier — keep it.
- **Watched is GB-weighted, per-episode.** A movie or an individual episode with a Plex
  history entry (≈ Plex's ~90% scrobble) counts its own file size as watched GB; show
  episodes are scoped to the user's requested seasons. Denominator = requests with
  `media.status ∈ {4,5}` (on disk). Watch rate = watched GB ÷ requested GB.
- **Watch tracking is per Plex account.** A user who watches under a different Plex profile
  won't match; the owner frequently reads ~0%. **Tautulli is the documented drop-in upgrade**
  for durable history — keep the watch-history read behind a small provider seam so it can be
  swapped without touching analytics or UI.
- **Plex speaks plain HTTP on `:32400`** despite "secure connections required" — the dashboard
  relies on this; fine for LAN server-to-server.
- **Seerr has no host port**; it's `http://seerr:5055` on the `seerr_default` docker network.
  Our container must **join that network** (or reach Seerr via the Caddy/tunnel hostname).
- **`POST /api/v1/auth/plex` creates a first admin user if none exist.** Not a risk here (Seerr
  is already set up), but a reason to prefer the API-key + `plexId` lookup for our gate — it has
  no create/mutate side effects and needs no per-user Plex token round-trip on our backend.
- **ADMIN bit dominates.** `hasPermission` short-circuits `true` for any ADMIN-bit user, so a
  single `& 2` check is the whole admin gate; finer permissions matter only if we later expose
  request/manage features.
- **Proxy-vs-reimplement tradeoff (Phase 3):** proxying the FastAPI dashboard avoids re-solving
  its hardest, host-coupled code (cgroup PID-namespace translation, GPU sampler, socket-proxy),
  but couples the admin view's uptime to that container being reachable. Acceptable for the
  companion phase; porting the collectors into Node is deferred replacement-phase work.
- **`node --test <dir>` runs `index.js` on Node 22**, starting the server instead of discovering
  tests. Use the quoted glob: `node --test "dist/**/*.test.js"` (the `test` script does this).
- **Desktop Commander spawns children with `NODE_ENV=production`.** The server correctly skips
  `.env` loading in production, so a DC-launched dev instance sees no config and exits with
  "Invalid PLEX_CLIENT_ID". Force `NODE_ENV=development` when running the server via DC. Not an
  app bug; `npm run dev` in a normal terminal is unaffected.
- **Dev vs prod `SEERR_URL`.** Local dev points at the public tunnel `https://seerr.tylerte.dev`
  (the Docker-internal `http://seerr:5055` is unreachable from the Mac); prod (Docker on the Dell)
  uses `http://seerr:5055`. The same split will apply to `PLEX_BASEURL` + Plex token in Phase 2.
- **Owner identity (verified live):** the owner Plex account `id 309174878` (`tylerte221`) resolves
  to Seerr user `id 1` with `permissions: 2` (exactly the ADMIN bit) → `isAdmin` true.

## 6. Core logic — watched-vs-requested (to port in Phase 2)

Reference implementation: `dashboard/app/main.py`, `build_user_report()` and the `Plex`
client. The shape to preserve:

1. Pull Seerr `users` and `requests`; index requests by `requestedBy.id`.
2. Resolve the user's Plex history `accountID` (plexId match; username fallback for owner=1).
3. For each request that is **on disk** (`media.status ∈ {4,5}`): fetch the Plex item by
   `ratingKey`. Movie → watched if its ratingKey is in the account's movie-history set.
   Show → sum episode file sizes for the **requested seasons**; an episode counts as watched
   if its ratingKey is in the account's episode-history set.
4. `rate = watchedGB / requestedGB`. Posture thresholds: ≥0.70 "Approve freely", ≥0.40 "Watch",
   else "Scrutinize" (env-tunable `APPROVE_FREELY`, `WATCH_LIST`).
5. Cache results (the Python side caches users ~120s; Plex item sizes memoized).

For Phase 2 we compute this for **one** user (the logged-in one) — cheaper than the full sweep.
Keep a `WatchProvider` seam (Plex today, Tautulli later).

## 7. Build / run / test

- Local dev: `server/` on one port, `web/` Vite dev server proxying `/api` to it. Backend needs
  a `.env` (see `.env.example`) with a Plex client id, Seerr base URL + API key, dashboard base
  URL, session secret.
- Smoke-test ritual (per phase, before commit): run it, exercise the new behavior in a browser,
  confirm observable behavior matches the spec's acceptance criteria. Details per-increment.
- Prod: `docker compose up -d --build` on the Dell after merging the compose snippet; verify at
  the tunnel hostname.

## 8. Increment history & roadmap

Naming: **integers = features** (Phase 1, 2…), **decimals = polish/bugfix** (4.1, 4.2…),
one concern each. Newest at the bottom.

Roadmap (planned):
- **Phase 0 — Scaffold.** Monorepo, TypeScript, Express server with `/healthz`, React+Vite
  shell, config-fail-loud, Dockerfile, `.env.example`. No auth, no upstream calls.
- **Phase 1 — Plex login + Seerr-backed role gate + session.** PIN flow, who-am-I, Seerr
  `plexId` lookup for permissions, own session cookie, `/api/auth/me`, `ProtectedRoute`,
  logout. Spec: `docs/phase-1-auth-spec.md`.
- **Phase 2 — User view: "My watched vs requested."** Port `build_user_report` for the
  logged-in user; `/api/me/stats`; user dashboard page. Verify numbers match the admin
  dashboard for the same user.
- **Phase 3 — Admin view (admin-only).** Proxy the dashboard JSON APIs behind the admin gate;
  re-present system/storage, per-user table, jobs, containers. Likely split 3.1–3.4.
- **Phase 4 — Deploy.** Dockerize into the Dell stack + Cloudflare tunnel hostname; secrets;
  don't route the public hostname until the Phase 1 gate is smoke-tested.
- **Phase 5+ (future / "more ideas" → replacement path):** TMDB browse, request submission →
  Radarr/Sonarr, notifications, own user store. Deferred.

Log (newest at bottom):
- **Phase 0** — scaffold (Express 5 + Vite/React/TS monorepo, `/healthz`, fail-loud config,
  multi-stage Dockerfile). Verified: dev "backend: ok", bad `PORT` exits loud, prod build serves both.
- **Phase 1.1** — Plex OAuth PIN round-trip (backend): `POST /api/auth/plex/start`,
  `GET /api/auth/plex/check`. Verified live against Plex (pending → approve → real Plex identity).
- **Phase 1.2** — Seerr-backed authorization + signed session: `getUserByPlexId`, HMAC session
  cookie, `/api/auth/me`, `/api/auth/logout`, `requireAuth`/`requireAdmin`, and a temporary
  `GET /api/admin/ping` gate probe (**replace in Phase 3**). Verified live (owner → isAdmin) and
  with forged/tampered/expired cookies (401/403/200 all correct).
- **Phase 1.2.1** — unit tests (`node:test`, no deps) for config, session, Seerr client;
  `npm test` (server) = `build && node --test "dist/**/*.test.js"`. 20 tests; mutation-checked.
- **Phase 1.3** — frontend Plex login (popup + poll), `AuthContext`, `ProtectedRoute`/`AdminRoute`,
  Home + stub Admin page (`react-router-dom` v7). Verified: web build, prod single-origin serving,
  and live browser login as admin.
- **Phase 1 COMPLETE.**
- **Phase 2.1** — GET /api/me/stats (behind requireAuth): new Plex media-server client (accounts /
  history / library item sizes), Seerr getRequestsByUser, and a pure computeWatchedVsRequested join
  (GB-weighted, per-episode, requested-season-scoped). node:test for the join incl. the empty-seasons
  case. **Verified live: byte-for-byte identical to the dashboard's owner row** (201,258,420,458
  requested / 31,297,353,970 watched / rate 16). Owner resolves to Plex history accountID 1 via the
  username fallback (plexId 309174878 is not itself a history account key).
- **Phase 2.2** — Home renders the stats (rate + CSS bar, requested/watched/unwatched totals, counts,
  largest-first unwatched titles with movie/TV tags + x/y eps) with loading and error/retry states.
  Verified in-browser (16% watched, 187.4 GB requested, 12 unwatched titles).
- **Phase 2 COMPLETE.**
- **Phase 3.1** — admin dashboard proxy: `createDashboardClient` (10s timeout) + a whitelisted
  `GET /api/admin/{system,users,jobs,containers}` router behind `requireAdmin` (fixed whitelist → no SSRF);
  removed the temporary `/api/admin/ping`. Frontend admin shell + System/Storage panel. Verified: gate
  401/403/200, whitelist 404, dashboard-down 502.
- **Phase 3.2** — per-user watched-vs-requested table with posture badges (approve/watch/scrutinize) and
  expandable unwatched-titles. Reworked to a single shared CSS-grid layout (header + all rows) after a
  column-overflow bug with the `(+N pending)` note (now a sub-line; cells `min-width:0`).
- **Phase 3.3** — Jobs panel (schedule, last/next run via `formatEpoch`, ok/attention badges,
  attention-first). Surfaced a live real alert (Byparr "indexers FAILING").
- **Phase 3.4** — Containers panel: Docker sub-table (11 rows: state+health badges, CPU/mem/net/uptime,
  pids/restarts/blk) + Native services (Plex/Radarr/Sonarr/Prowlarr). `docker.ok===false` shows the error.
- **Phase 3 COMPLETE.** All four admin panels live behind the admin gate, verified in-browser.
  Next: Phase 4 (deploy — Docker on the Dell behind the Cloudflare tunnel).

## 9. Deferred / candidate future work

- Full Seerr replacement (own request pipeline, TMDB discovery) — the long-term goal.
- Port host-metric collectors into Node to drop the FastAPI-dashboard dependency.
- Tautulli-backed watch history for durable, profile-independent accuracy.
- Cloudflare Access on `/admin` as defense-in-depth.

### Known technical debt (accepted for now)
- Admin view depends on the Python dashboard being up (proxy approach).
- Watch history is Plex-only (owner may read ~0%).
- In production, unmatched `/api/*` routes fall through to the SPA catch-all (return index.html, not a 404
  JSON). Harmless today (dev returns 404; the admin whitelist prevents SSRF) — add an `/api` 404 guard
  before the catch-all in Phase 4.

## 10. Rollout / status

Phases 1–3 complete and verified live (Plex auth + Seerr role gate; per-user watched-vs-requested,
byte-matched to the dashboard; full admin dashboard — system/storage, per-user table, jobs, containers —
proxied behind requireAdmin). `.env` now also carries `DASHBOARD_URL`. Not yet deployed. Next: Phase 4 —
containerize (the multi-stage Dockerfile already builds web+server into one image), set prod env
(SEERR_URL/PLEX_BASEURL/DASHBOARD_URL become Docker-internal on the Dell), add the container to the Dell
compose, wire a Cloudflare tunnel hostname, and add an `/api` 404-guard before the SPA catch-all.

## 11. Working patterns established

- Claude plans + reviews; Cursor implements; Tyler runs/commits. Review is on **real file
  contents**, not the agent's summary. One concern per prompt. No commit before smoke test.
- Fail-loud on bad/missing config and upstream errors; no silent fallbacks.
- Secrets server-side only; client never trusted for authorization.

## 12. Documents in the repo

- `docs/HANDOFF.md` — this file (kept current).
- `docs/phase-1-auth-spec.md` — Phase 1 design + decision log.
- Reference (external): `Home Media Server/dashboard/app/main.py` — the analytics + metrics
  source of truth to port/proxy.
