# Tyflix Web — Project Handoff Document

> Living doc. Its job is to let a fresh conversation pick up this project cold.
> Keep it current; delete guidance notes as you go.
>
> **Last updated after:** Phase 9 (2026-07-14). Architecture PIVOTED to **Seerr-backed** during Phase 5 (own-store SQLite/Radarr/Sonarr pipeline built 5.1–5.7, then **retired** 5.8–5.10; requests flow through Seerr's API). Since then, shipped parity features on that architecture: **6** media-status badges in discovery, **7** Plex Watchlist, **8** issue reporting (report/list/detail/comments/admin), **9** TMDB title+poster enrichment — all verified live + committed. See §3, the §8 log, and §10 status. Next: request-quota display / quality-profile selection, then Phase 4 deploy.
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
- **Product intent (as of 2026-07-15):** a **Seerr-backed enhancement** — NOT standalone, NOT a
  replacement. tyflix-web has its own Plex login + discovery/requesting UI + analytics, but **every request
  flows through Seerr's API** (Seerr = single source of truth → always in sync; Seerr owns approvals +
  Radarr/Sonarr + availability). The backend's unique value is the analytics/dashboard Seerr lacks. Goal:
  build toward **parity with Seerr's UI** (mining Seerr's MIT source) while Seerr stays the engine. (Earlier
  "standalone companion → full replacement" framing was superseded — see the Phase 5 pivot in the log.)
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
- **Requests layer (Phase 5, Seerr-backed):** discovery via TMDB (`/api/discover/*`); requesting + reading +
  approve/decline all go through **Seerr's API** (`POST/GET /api/v1/request`, `/request/{id}/approve|decline`),
  submitted on behalf of the logged-in user via the Seerr API key. tyflix-web keeps **no** request store of
  its own — Seerr is the source of truth (in sync). Seerr's two-axis status (request `status` + `media.status`)
  maps straight to our `requestStatus`/`mediaStatus`.
- **Media-status overlay (Phase 6):** discovery results (trending/search/movie/tv) are annotated with each
  title's Seerr availability via a shared `createMediaStatusProvider` — it paginates `GET /api/v1/media`, builds
  a `` `${mediaType}:${tmdbId}` `` → status map, caches 60s, and degrades to null on failure (discovery never
  breaks). The frontend shows status badges + a `canRequest()` gate (hides Request for available/processing/pending).
- **Watchlist (Phase 7):** `GET /api/watchlist` proxies the logged-in user's Plex Watchlist from Seerr
  (`GET /api/v1/user/{seerrUserId}/watchlist`), annotated with the same media-status provider. Read-only (Plex
  owns the watchlist).
- **Issues (Phase 8):** `/api/issues*` mirrors Seerr's issue model (report/list/detail/comment/resolve-reopen).
  Because we call Seerr with the admin API key, **Seerr's per-user checks are bypassed → our routes enforce
  owner-or-admin themselves** (like requests). Create resolves the Seerr internal `mediaId` via the provider's
  `getMediaId`; only the initial report message is attributed to the acting user (later comments post as the
  API-key/owner account).
- **Enrichment (Phase 9):** a shared `createMediaEnrichment(tmdb)` resolves title+posterUrl by `mediaType:tmdbId`
  (10-min cache, parallel, per-item fail-soft) to fill gaps in Seerr payloads — watchlist cards get posters,
  issue lists/detail get real titles + poster thumbs.

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
- **Radarr `/movie/lookup` returns `hasFile=undefined` for library movies** (discovery endpoint, not library
  state). Seerr's addMovie (which we copied, then retired) relied on it → owned media read as "processing" +
  triggered a redundant search. If ever talking to Radarr directly again, use `GET /movie/{id}` for reliable
  `hasFile`. (Moot now — Seerr owns Radarr/Sonarr.)
- **Seerr request = two axes.** `status` (1 pending,2 approved,3 declined,4 failed,5 completed) AND
  `media.status` (1 unknown … 4 partially_available,5 available). Map straight to `requestStatus`/`mediaStatus`.
  Submit on behalf of a user: `POST /api/v1/request { mediaType, mediaId:<tmdbId>, seasons?, userId }` + API key.
- **Test looping catches flakiness single runs miss.** A base64url signature-tamper test flipped the LAST sig
  char, which (unpadded HMAC) can decode to the same bytes → ~25% flaky. Tamper a FULLY-significant char (first)
  instead. Run suspect suites ~15–20× when in doubt.
- **Deployed Seerr's issue API diverges from the develop-branch source — verify against the live instance.**
  `GET /api/v1/issue` only accepts `sort ∈ {added, modified}` (NOT `created`), **rejects a `createdBy` query
  param entirely** ("Unknown query parameter"), and when `filter` is omitted defaults to **OPEN-only** (the
  develop source suggests all statuses — it lies for this build). So `listIssues` must send
  `?take=&skip=&sort=added&filter=all` and we filter own-vs-all **in our code** (Seerr can't filter by creator).
  Two live bugs came from trusting the source: `sort=created`+`createdBy` (8.1 → fixed 8.1.1) and the
  omitted-filter open-only default that hid resolved issues (fixed post-8.3 with `filter=all`).
- **Issue create needs Seerr's internal `mediaId`, not tmdbId.** Resolve `mediaType:tmdbId → mediaId` via the
  media provider's `getMediaId` (built from the same cached `GET /api/v1/media`). Reporting on an untracked
  title → 404. `POST /api/v1/issue { issueType:1-4, message, mediaId, userId }`; the initial message is
  attributed to `userId` (pass the acting user), but `POST /:id/comment` has no userId override so later
  comments post as the API-key/owner account (documented limitation, surfaced in the UI).
- **Issue CREATE response is un-enriched** (media.title null); GET list/detail enrich it. Harmless — the report
  form doesn't show the title, and the detail page re-fetches (enriched).
- **Seerr watchlist payload has no poster.** `GET /api/v1/user/{id}/watchlist` returns `{ id, ratingKey, title,
  mediaType, tmdbId }` — title but no poster/overview. Posters come from Phase 9 TMDB enrichment.
- **Live-verify pattern (no login UI needed).** Forge a `tyflix_session` cookie with a node script — sign the
  **HMAC over the JSON string**, not the base64url payload — then curl the running server; or drive the
  already-logged-in Personal Chrome (Claude-in-Chrome) against the vite dev server. Create real Seerr issues for
  e2e, then clean up with `DELETE /api/v1/issue/{id}` (API key) and confirm `issue/count` returns to 0.

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
- **Phase 5 — Requests (Seerr-backed). COMPLETE.** Built an own-store MVP (5.1–5.7: SQLite + Radarr/Sonarr
  clients + approval) then **pivoted 2026-07-15** to route everything through Seerr (5.8 Seerr request routes
  → 5.9 UI align → 5.10 removed the own-store/servarr/DB). Net: TMDB discovery UI that requests via Seerr;
  My Requests + admin approval queue read/write Seerr; all in sync. (`phase-5-replacement-spec.md` is
  SUPERSEDED — it documents the retired own-store approach.)
- **Phase 6 — Media-status overlay. COMPLETE.** Availability badges in discovery + Request-button gating.
- **Phase 7 — Watchlist. COMPLETE.** Per-user Plex Watchlist page (Seerr-backed), shared status provider.
- **Phase 8 — Issue reporting. COMPLETE.** Report/list/detail/comments/resolve-reopen + admin panel.
- **Phase 9 — TMDB enrichment. COMPLETE.** Titles + posters for watchlist cards and issue lists/detail.
- **Parity backlog (remaining, via Seerr's API):** request-quota display, quality-profile selection. (4K is
  N/A — no 4K server in this Seerr. Notifications/settings/user-management stay delegated to Seerr by design.)
  Goal = parity with Seerr's user-facing UI, Seerr as the engine.
- **Phase 4 — Deploy.** Dockerize into the Dell stack + Cloudflare tunnel hostname `tyflix-dashboard.tylerte.dev`;
  prod env; add the `/api` 404-guard; don't route the public hostname until the admin gate is smoke-tested in
  prod. (No DB volume needed — no own store.)

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
- **Phase 5.1 / 5.1.1** — SQLite requests store (better-sqlite3), two-axis request/media status. *(Retired in 5.10.)*
- **Phase 5.2 / 5.3** — TMDB client + discovery endpoints; discovery UI (browse/search/detail). *(Kept.)*
- **Phase 5.4** — Radarr/Sonarr API clients (adapted from Seerr's servarr code). *(Retired in 5.10.)*
- **Phase 5.5 / 5.6 / 5.7** — own request routes + approval, requesting UI, admin approval queue. Verified live
  (auto-approve/pending/dup/approve). *(Routes retired/repointed in 5.8–5.10.)*
- **PIVOT 2026-07-15** — Tyler: "not standalone; enhance Seerr; data in sync." → Seerr becomes the single
  source of truth for requests.
- **Phase 5.8** — Seerr-backed request routes: submit/list/approve/decline via Seerr's API (on behalf of the
  user); `/api/me/stats` switched to Seerr's per-user endpoint. **Verified live: me/stats still byte-matches the
  dashboard; a request made in tyflix-web appears in Seerr (in sync).**
- **Phase 5.9** — UI aligned to the Seerr-backed `RequestView` (+ completed/blocklisted/deleted statuses).
- **Phase 5.10** — deleted the retired own-store/Radarr/Sonarr/DB code + config + better-sqlite3; skip-not-throw
  hardening in the Seerr list mapper. 43 tests; all endpoints re-verified working.
- **Phase 5 COMPLETE (Seerr-backed).** Next: parity backlog (via Seerr) and/or Phase 4 deploy.
- **Phase 6.1** — backend media-status overlay: `listMedia` + `mediaStatusFromCode`, 60s cache, annotate
  `/api/discover/*` with `mediaStatus` (`mediaType:tmdbId` key), fail-soft to null. Verified live: trending/
  detail tagged (Severance→partially, Blade Runner→available); keying discriminates movie vs tv.
- **Phase 6.2** — frontend badges + `canRequest()` gating (available→"Available", processing/pending→
  "Requested", partial→still requestable). Verified in-browser.
- **Phase 7** — Watchlist: `listUserWatchlist` + `GET /api/watchlist` (requireAuth), **extracted shared
  `createMediaStatusProvider`** (discover + watchlist) and **extracted `MediaCard`**. WatchlistPage + nav.
  Verified live: 13 items, status-annotated, 401 without cookie.
- **Phase 8.1 / 8.1.1** — issue backend: client (list/get/create/comment/status) + `getMediaId` on the provider
  + `/api/issues*` routes with **owner-or-admin enforcement in our code** (admin key bypasses Seerr's checks).
  8.1.1 fixed `sort=created`/`createdBy` rejection (→ `sort=added`, filter own in code). Verified e2e vs live
  Seerr: create→count 0→1, per-user scoping, non-owner 403, untracked 404, clean delete.
- **Phase 8.2** — issue frontend: report form (tracked-media only) + My Issues list. Verified in-browser: filed
  an Audio issue → "Issue reported" → appeared in My Issues → in Seerr → cleaned up.
- **Phase 8.3 (+ list fix)** — issue detail (comments, add-comment, resolve/reopen; owner-or-admin gated) +
  admin Issues panel. Fixed the omitted-filter **open-only** default (→ `filter=all`) so resolved issues stay
  visible. Verified in-browser: detail→comment→resolve→visible in admin panel; cleaned up.
- **Phase 9** — TMDB enrichment: shared `createMediaEnrichment` (title+poster, 10-min cache, parallel,
  fail-soft); watchlist posters + issue titles/thumbs. Verified live: 13/13 watchlist posters resolve; issue
  media enriches to "Blade Runner" + poster. **64 server tests.**
- **Phases 6–9 COMPLETE + committed.** Next: request-quota display / quality-profile selection, then Phase 4 deploy.

## 9. Deferred / candidate future work

- **Parity backlog (remaining, via Seerr's API):** request-quota display, quality-profile selection. Done so
  far: media-status badges (6), watchlist (7), issue reporting (8), enrichment (9). 4K is N/A (no 4K server);
  notifications, settings, user-management, and richer discovery (recommendations/similar/cast/genre browse)
  stay delegated to Seerr or are unbuilt. Goal = parity with Seerr's user-facing UI, Seerr as the engine.
- **Cosmetic/polish:** corner status badge can overlap poster title art; consider a scrim/reposition.
- Own user store / retiring Seerr — explicitly NOT the direction anymore (tyflix-web enhances Seerr, in sync).
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

Phases 1–3, 5, and **6–9** complete and verified live. tyflix-web is a **Seerr-backed enhancement**: Plex login
+ Seerr admin gate; TMDB discovery UI with **media-status badges** that requests **through Seerr** (in sync);
My Requests + admin approval queue reading/writing Seerr; **Plex Watchlist**; **issue reporting** (report/list/
detail/comments/resolve + admin panel); **TMDB title+poster enrichment**; per-user watched-vs-requested + the
full admin dashboard. No own request store (retired). **64 server tests.** **Not deployed.** Next: **parity
backlog** (request-quota display, quality-profile selection — via Seerr) and/or **Phase 4 deploy** (hostname
`tyflix-dashboard.tylerte.dev`; add the `/api` 404-guard; prod build currently doesn't serve the SPA at `/` —
must fix before routing the hostname). Local dev: `npm run dev`; `.env` carries PLEX_*, SESSION_SECRET,
SEERR_URL+key, TMDB_API_KEY, DASHBOARD_URL (`RADARR_*`/`SONARR_*`/`DB_PATH` are stale/ignored — safe to delete).

## 11. Working patterns established

- Claude plans + reviews; Cursor implements; Tyler runs/commits. Review is on **real file
  contents**, not the agent's summary. One concern per prompt. No commit before smoke test.
- Fail-loud on bad/missing config and upstream errors; no silent fallbacks.
- Secrets server-side only; client never trusted for authorization.

## 12. Documents in the repo

- `docs/HANDOFF.md` — this file (kept current).
- `docs/phase-1-auth-spec.md` — Phase 1 design + decision log (current).
- `docs/phase-5-replacement-spec.md` — **SUPERSEDED / HISTORICAL.** Describes the own-store request MVP we
  built (5.1–5.7) then retired in the 2026-07-15 Seerr-backed pivot. Kept for decision history; do NOT build
  from it — the live architecture is §3 + the Phase 5 log above.
- Reference (external): `Home Media Server/dashboard/app/main.py` — the dashboard analytics/metrics source of
  truth (proxied by Phase 3).
