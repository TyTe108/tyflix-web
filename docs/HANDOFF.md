# Tyflix Web — Project Handoff Document

> Living doc. Its job is to let a fresh conversation pick up this project cold.
> Keep it current; delete guidance notes as you go.
>
> **Last updated after:** Phase 4 — Deploy (2026-07-17). Architecture PIVOTED to **Seerr-backed** during Phase 5 (own-store SQLite/Radarr/Sonarr pipeline built 5.1–5.7, then **retired** 5.8–5.10; requests flow through Seerr's API). Since then, shipped the full parity backlog on that architecture: **6** media-status badges, **7** Plex Watchlist, **8** issue reporting, **9** TMDB enrichment, **10** recommendations + popular/genre browse, **11** cast/person/collections/studio-network/upcoming, **12** request-quota display + quality-profile selection — all verified live + committed (103 server tests). Discovery now mirrors Seerr's full surface; **~90% of Seerr's user-facing UI** is done. Then **Phase 13 — UI modernization**: a sleek **dark theme** (design tokens), a persistent **left-sidebar app shell**, **tabbed Admin**, and **poster-forward request cards** — the app now reads like Seerr/Plex rather than the old flat light editorial look. See §3, the §8 log, and §10 status. **Deployed 2026-07-17 at `tyflix.tylerte.dev`** (Phase 4). Remaining Seerr features are delegated by design (notifications/settings/*arr-config/user-management) or N/A (4K — no 4K server).
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
- **Discovery expansion (Phases 10–11):** all TMDB-backed, all status-overlaid via annotateMediaStatus and all
  reusing MediaCard. `recommendations` ("More like this" on detail, /recommendations + /similar fallback);
  `discover` browse by media-type + genre + studio(with_companies)/network(with_networks) — genres from
  /genre/list, a **curated** studio/network id list (tmdb/studios.ts) since TMDB has no "list studios" endpoint;
  `upcoming` (/movie/upcoming + /tv/on_the_air); `credits` (cast + key crew on detail); `person` pages
  (/person/{id} + combined_credits) reached from clickable cast; `collection` pages (belongs_to_collection +
  /collection/{id}). Key gotcha: only /trending, /search, and /recommendations include `media_type` per row —
  /similar, /discover, /popular, /upcoming DON'T, so `mapMediaSummary(row, defaultMediaType)` injects it.
- **Request quota + quality profiles (Phase 12):** `GET /api/me/quota` proxies Seerr `/user/{id}/quota`
  (limit 0 = unlimited). Admin-only quality-profile selection: `GET /api/requests/profiles` (from Seerr
  `/service/{radarr|sonarr}/{serverId}`) + `POST /api/requests` accepts an optional `profileId` that is
  **admin-gated in our route (403 for non-admins, checked before creation)** and forwarded to Seerr with the
  resolved serverId.

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
- **TMDB single-type endpoints omit `media_type`.** /trending, /search/multi, and /{type}/{id}/recommendations
  include `media_type` per row; /similar, /discover, /movie|tv/popular, /movie/upcoming, /tv/on_the_air, and
  /collection parts DO NOT (type is implied by the endpoint). Always pass `mapMediaSummary(row, defaultMediaType)`
  for those. Also: `include_adult=false` on discover/search.
- **No "list all studios" TMDB endpoint** → studio/network browse uses a hand-curated verified id list
  (server/src/tmdb/studios.ts): studios via `with_companies` (Disney 2, Pixar 3, Marvel 420, WB 174, Universal
  33, Columbia 5, Paramount 4, Lucasfilm 1, 20th Century 25, A24 41077, DreamWorks 521), networks via
  `with_networks` (Netflix 213, HBO 49, HBO Max 3186, Disney+ 2739, Apple TV+ 2552, Prime 1024, Hulu 453,
  Showtime 67, FX 88, Paramount+ 4330, Peacock 3353). For TV "upcoming" use /tv/on_the_air (airing_today is
  talk-show noise).
- **Quota `limit: 0` = unlimited.** Seerr `/user/{id}/quota` returns `{movie,tv}:{days,limit,used,restricted}`;
  this server has no limits set, so the UI shows "Unlimited". Quality-profile ids (this Seerr): 1 Any, 2 SD,
  3 HD-720p, 4 HD-1080p, 5 Ultra-HD, 6 HD-720p/1080p; default radarr/sonarr serverId 0, activeProfileId 1.
- **Real request = real download.** POSTing a request to Seerr auto-approves for admins → Radarr/Sonarr grab
  immediately. When verifying request/quality-profile changes, prefer read-only checks + unit tests; only do a
  live create-request e2e if you can clean up in Radarr/Sonarr afterward.
- **UI design system (Phase 13).** All theming flows through CSS custom-property tokens defined on :root in
  web/src/styles.css (--bg/--surface/--surface-2/--border/--text/--text-muted/--accent(+hover/contrast)/
  --ok/--warn/--info/--danger/--radius/--shadow-1/-2/--transition) — the theme is DARK; add new colors as tokens,
  never raw hex in component CSS. The app shell (components/AppShell.tsx) is a react-router LAYOUT ROUTE wrapping
  all protected routes (sidebar + <Outlet/>); /login is outside it; new authed pages just add a route inside the
  shell (no per-page nav header — the sidebar owns nav). Nav icons are inline SVGs (no icon dep). Admin tabs use
  ?tab= (useSearchParams). Request posters (RequestView.posterUrl) are filled by enrichRequest reusing the
  per-request TMDB detail fetch — free; keep it that way.

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
- **Phase 10 — Discovery: recommendations + browse. COMPLETE.** "More like this" on detail (10.1); popular +
  genre browse (10.2).
- **Phase 11 — Discovery: breadth. COMPLETE.** Cast & crew (11.1), person pages (11.2), collections (11.3),
  studio/network browse (11.4), upcoming (11.5).
- **Phase 12 — Request parity. COMPLETE.** Request-quota display (12.1), admin quality-profile selection (12.2).
- **Parity backlog: CLEARED.** Everything targeted is built. Not built (by design / N/A): notifications,
  settings, *arr config, user management (delegated to Seerr); 4K (no 4K server). Smaller unbuilt niceties:
  request editing, blocklist management, i18n. Goal reached = parity with Seerr's user-facing UI, Seerr as the engine.
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
- **Phases 6–9 COMPLETE + committed.**
- **Phase 10.1** — "More like this" on detail: tmdb.recommendations (/recommendations + /similar fallback),
  GET /api/discover/:type/:id/recommendations (status-overlaid), MediaCard row on detail. Verified live
  (Blade Runner → Blade Runner 2049/Terminator…).
- **Phase 10.2** — popular + genre browse: tmdb.genres + tmdb.discover, GET /api/discover/genres + /browse,
  DiscoverPage All/Movies/TV toggle + genre selector + dynamic headings. Verified live (Sci-Fi movies).
- **Phase 11.1** — cast & crew: tmdb.credits, GET /api/discover/:type/:id/credits, Cast row + crew line on
  detail. Verified live (Harrison Ford/Deckard; "Directed by Ridley Scott").
- **Phase 11.2** — person pages: tmdb.person + personCredits (dedupe, drop "Self", sort by popularity, cap 24),
  GET /api/discover/person/:id, PersonPage (/person/:id) + clickable cast. Verified live (Harrison Ford page).
- **Phase 11.3** — collections: movieDetail.collection + tmdb.collection, GET /api/discover/collection/:id,
  "Part of the {name}" link + CollectionPage. Verified live (Blade Runner Collection: 1982 + 2049).
- **Phase 11.4** — studio/network browse: curated tmdb/studios.ts, GET /api/discover/studios, /browse forwards
  companyId/networkId, Studio(Movies)/Network(TV) selectors + heading priority. Verified live (Marvel Studios).
- **Phase 11.5** — upcoming: tmdb.upcoming (/movie/upcoming + /tv/on_the_air), GET /api/discover/upcoming,
  [Popular|Upcoming] segmented control. Verified live (Upcoming Movies).
- **Phase 12.1** — request-quota display: seerr.getUserQuota, GET /api/me/quota, "Request quota" summary on
  My Requests. Verified live (Unlimited).
- **Phase 12.2** — admin quality-profile selection: seerr.getServiceProfiles, createRequest forwards
  profileId+serverId, GET /api/requests/profiles (admin) + profileId admin-gate on POST (403 pre-create),
  admin-only selector on the request control. Verified live (profiles list; non-admin 403; selector renders).
  Did NOT submit a real request (download side-effect); forwarding covered by unit tests.
- **Phases 10–12 COMPLETE + committed. 103 server tests. Parity backlog cleared.**
- **Phase 13.1** — dark theme: full CSS design-token system (:root custom properties) + sleek dark (Seerr-like)
  palette in styles.css; every color/shadow/radius routed through a token; depth (shadows) + motion (hover-lift
  on media cards, transitions), global :focus-visible, prefers-reduced-motion. CSS-only reskin. index.html
  color-scheme/theme-color. Verified live (Discover + Admin dark/clean).
- **Phase 13.2** — left-sidebar app shell: components/AppShell.tsx (sticky sidebar: Tyflix wordmark, NavLink
  items w/ inline SVG icons + active states, user + Logout); App.tsx nests protected routes in the shell
  (AdminRoute gate kept; /login outside); removed per-page header link rows from the 6 top-level pages (kept
  titles + sub-page Back links); content widened (.page-wide 48→72rem → ~7-across grid); responsive icon rail
  <820px. No deps (inline SVGs). Verified live.
- **Phase 13.3** — admin tabs: AdminPage is a tab bar (Requests default | Issues | Users | System | Jobs |
  Containers) rendering only the active panel (lazy self-fetch on select); ?tab= query persistence via
  useSearchParams; extracted a self-fetching SystemPanel (presentational → SystemBody). Verified live.
- **Phase 13.4** — Seerr-style request cards: RequestView gains posterUrl (backend toRequestView + enrichRequest
  reuse the existing per-request TMDB detail fetch — no new API calls); shared components/RequestCard.tsx
  (poster→detail link, title, type, status badge, meta, optional approve/decline for pending) used by the admin
  queue (with requester + actions) and My Requests. Verified live (posters DOM-confirmed rendering).
- **Phase 13 COMPLETE + committed. UI modernized (dark + sidebar + admin tabs + poster request cards).** Next: **Phase 4 deploy**.
- **Phase 13.5** — auto-refresh admin metric panels: new `usePolledResource<T>(fetcher, intervalMs)` hook
  (immediate load + `setInterval`, overlap guard, unmount cancel, in-place background refresh) driving System
  & Containers (5s), Jobs (30s), Users (60s). No loading flash on ticks; a transient poll failure keeps
  last-good data plus a muted `Updated {time} · couldn't refresh` line; first-load failure still shows
  error + Retry (wired to `refresh()`). Requests/Issues deferred to 13.6/13.7. Frontend-only;
  `tsc -b && vite build` clean; net −98 lines in `AdminPage.tsx`.
- **Phase 13.6** — admin Issues panel auto-refresh: `IssuesPanel` swapped to
  `usePolledResource(fetchAllIssues, 60000)` (list from `data ?? []`), reusing the shared `UpdatedLine`;
  Retry → `refresh()`; gates unchanged. Frontend-only; dropped the now-unused `IssueView` import;
  `tsc -b && vite build` clean.
- **Phase 13.7** — admin Requests panel auto-refresh: `RequestsPanel` list now driven by
  `usePolledResource(fetchAllRequests, 30000)`, rows derived via
  `useMemo(() => pendingFirst(data ?? []), [data])` (no shadow list copy). `actionError`/`activeRequestId`
  stay local so a background poll can't drop them; `runAction` calls `refresh()` after approve/decline
  instead of mutating a local copy; Retry → `refresh()`; `UpdatedLine` added. Removed the now-unused
  `useEffect`/`LoadStatus`, added `useMemo`. `tsc -b && vite build` clean. Caveat: Approve triggers a real
  Radarr/Sonarr grab — smoke-test the action path only with a disposable pending request.
- **Phase 13.5–13.7 COMPLETE.** All six admin panels now auto-refresh (System/Containers 5s, Jobs 30s,
  Users 60s, Requests 30s, Issues 60s) with no loading flash and keep-last-good on transient failures —
  no manual reload needed.
- **Phase 13.8** — System tab visual parity: replaced the flat `admin-metrics` `<dl>` with six
  `.admin-tile` cards (CPU, Memory, Load (1m), CPU temp, GPU busy, Transcoder), each a big number + a
  threshold-colored `.stats-bar`; GPU engines became five labeled `.stats-bar` rows; storage bars are now
  threshold-colored (fixes the always-green-drive bug). Added `usageBarClass`/`tempBarClass` helpers + a
  `barWidth()` clamp (0–100, null/NaN→0) and fill modifiers
  `.stats-bar-fill.is-ok/.is-warn/.is-danger/.is-info/.is-neutral` — all via tokens, no raw hex.
  `tsc -b && vite build` clean.
- **Phase 13.9** — Containers tab bars: Docker CPU + memory and Native CPU cells prepend a compact
  `.admin-bar-inline` track (reusing the `is-*` fills + `usageBarClass` + `barWidth`); numbers unchanged.
  Purely additive (+34/−0); `tsc -b && vite build` clean.
- **Phase 13.10** — Users tab watch-rate bars: each user row + the totals prepend an `.admin-bar-inline`
  bar via a new **inverted** `rateBarClass` (≥70 green / ≥40 amber / <40 red — higher is better); the
  7-column grid and numbers unchanged. `tsc -b && vite build` clean.
- **Phase 13.8–13.10 COMPLETE.** Admin view is now at **visual parity** with the old dashboard — metric
  tiles + threshold-colored bars (System), inline usage bars (Containers), and watch-rate bars (Users),
  layered on the 13.5–13.7 live auto-refresh.
- **Phase 13.11** — sortable Users table: clickable column headers (`UsersSortHeader` = a `<button>`
  inside each `.admin-users-cell` columnheader, with `aria-sort` + a ▲/▼ caret) drive local
  `sortKey`/`sortDir` state; rows come from `useMemo(() => [...data.users].sort(compareUsers), [users,
  sortKey, sortDir])` — non-mutating, sorting the numeric `gb_*`/`rate`/`total_requests` fields
  (null → −Infinity) and strings via `localeCompare`. Default Unwatched ▼; client-side + local so the
  60s poll preserves the chosen sort. Users tab only. `tsc -b && vite build` clean.
- **Phase 13.12** — paginated request lists: client-side pagination (20/page) via a shared
  `usePagination(items, pageSize)` hook (`web/src/hooks/`) + a `PaginationControls` component
  (`web/src/components/`, hidden at ≤1 page). Applied to the admin `RequestsPanel` (paging the
  pendingFirst-sorted list — pending stays on page 1; the 30s poll keeps the current page; approve/decline
  clamps) and `MyRequestsPage`. The hook clamps `safePage` on reads so a shrinking list never shows an empty
  trailing page. UI-only (backend still returns the full list). `tsc -b && vite build` clean.
- **Phase 13.13** — expose request `updatedAt`: threaded an `updatedAt` ISO string through SeerrRequest
  (mapped from the raw row, falling back to `createdAt` if absent) → toRequestView → the server + web
  `RequestView` types, so "Last Modified" sort has a field to use. Backend-only, no UI. Server `npm test`
  (103) + web build green.
- **Phase 13.14** — Seerr-style request filter + sort: new pure `web/src/lib/requestControls.ts`
  (`applyRequestControls` = filter by media + status, then sort by added/modified × asc/desc — non-mutating;
  status maps over requestStatus/mediaStatus) + a `RequestControls` component (media/status/sort selects + a
  direction toggle). Wired into the admin `RequestsPanel` and `MyRequestsPage` feeding `usePagination`;
  default Most Recent ▼ (the old pending-first default is dropped — pending is reached via Status→Pending); a
  control change resets to page 1, a poll does not. `tsc -b && vite build` clean.
- **Phase 13.15** — fix `.request-controls` CSS collision: 13.14 reused the class names of the pre-existing
  request-button/quality-profile controls (MediaDetailPage), whose `.request-controls` is
  `flex-direction: column`; the new toolbar never set flex-direction, so it inherited column → a vertical
  right-aligned stack with dead space. Renamed the new classes to `.request-filters` / `.request-filter` /
  `.request-filter-dir` (component + CSS) and set `flex-direction: row`. Now a horizontal toolbar; the
  request button is untouched. `tsc -b && vite build` clean.
- **Phase 13.13–13.15 COMPLETE.** Request lists now have Seerr-style media/status filters + Most Recent /
  Last Modified sort (with direction), layered on the 13.12 pagination.
- **Phase 4 — DEPLOY. COMPLETE 2026-07-17.** Live at **https://tyflix.tylerte.dev**. Runs as Docker container
  `tyflix-web` (image `tyflix/web:latest`) on the Dell at `/home/tyler/tyflix/tyflix-web`, on the
  **`seerr_default`** network (reaches `seerr:5055`; the `cloudflared` container reaches it by name), published on
  `<SERVER_LAN_IP>:8788` for LAN. Exposed via the existing token tunnel **`tyflix-dell`** → a **Published application
  route** (the renamed "Public Hostname" tab) `tyflix.tylerte.dev → http://tyflix-web:4000`. **4.1** added a JSON
  404 guard for unmatched `/api/*` (prod SPA serving already worked — the old "Cannot GET /" note was stale). Prod
  `.env` (mode 600) = the dev keys with prod URLs: `NODE_ENV=production`, `SEERR_URL=http://seerr:5055`,
  `PLEX_BASEURL=http://<SERVER_LAN_IP>:32400` (Plex is **native**, not a container — `plex:32400` won't resolve),
  `DASHBOARD_URL=http://<SERVER_LAN_IP>:8787`, fresh `SESSION_SECRET`. First deploy transported via **rsync from the
  Mac** (Dell has no GitHub creds yet). Verified end-to-end: `/healthz` 200, SPA at `/` + deep links, unknown
  `/api/*` → JSON 404, all four upstreams reachable, admin gate 401 unauthenticated over the tunnel. Cookies are
  `Secure` (login only over HTTPS, not the plain-HTTP LAN port). Follow-ups: commit+push 4.1; optional read-only
  deploy key for git-based redeploys; delete stale `RADARR_*`/`SONARR_*` env; optional Cloudflare Access on `/admin`.

## 9. Deferred / candidate future work

- **Parity backlog: CLEARED (Phases 6–12).** Built: media-status (6), watchlist (7), issues (8), enrichment (9),
  recommendations + popular/genre browse (10), cast/person/collections/studio-network/upcoming (11), quota +
  quality-profile (12). Not built by design: notifications, settings, *arr config, user management (delegated to
  Seerr). N/A: 4K (no 4K server). Unbuilt niceties if ever wanted: request editing, blocklist management, i18n,
  root-folder/language-profile selection.
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

Phases 1–3, 5, **6–12**, and **13** complete and verified live — **the Seerr-parity backlog is cleared (~90% of
Seerr's user-facing UI)** and the UI has been modernized (Phase 13: sleek **dark theme** via design tokens, a
persistent **left-sidebar app shell**, **tabbed Admin**, and **poster-forward request cards** — reads like
Seerr/Plex, no longer the old flat light look). tyflix-web is a **Seerr-backed enhancement**: Plex login + Seerr admin gate; a full discovery
UI (trending, search, popular, genre + studio/network browse, upcoming, "more like this" recommendations,
cast/crew, person pages, collections) with **media-status badges**, that requests **through Seerr** (in sync)
with **admin quality-profile selection**; My Requests (with **request-quota display**) + admin approval queue;
**Plex Watchlist**; **issue reporting** (report/list/detail/comments/resolve + admin panel); **TMDB
title+poster enrichment**; per-user watched-vs-requested + the full admin dashboard. No own request store
(retired). **103 server tests.** **DEPLOYED 2026-07-17** — live at **https://tyflix.tylerte.dev** (Docker on the Dell, `seerr_default`
network, behind the `tyflix-dell` Cloudflare tunnel; LAN `<SERVER_LAN_IP>:8788`). The `/api` 404-guard shipped
(4.1) and the prod SPA serves `/` + deep links. Local dev: `npm run dev`; `.env` carries PLEX_*,
SESSION_SECRET, SEERR_URL+key, TMDB_API_KEY, DASHBOARD_URL (`RADARR_*`/`SONARR_*`/`DB_PATH` are stale/ignored —
safe to delete).

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
