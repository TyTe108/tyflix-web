# Phase 5 — Seerr replacement (MVP request pipeline)

> Written up front. Decisions per Tyler 2026-07-13: **MVP scope** (grow later), approvals **mirror Seerr**,
> **run alongside Seerr** (Seerr stays the auth/permission backend). Build is Cursor-implements /
> Claude-reviews, one increment at a time. Sequenced **before Phase 4 (deploy)** at Tyler's direction.

## Goal

Give tyflix-web its own request pipeline so members can discover media (TMDB), request it, and have it
auto-flow to Radarr/Sonarr — enough to replace Seerr for everyday use. Seerr keeps running (auth +
permissions + its own requests) until this reaches parity; cut over later. **Not** full Overseerr parity
yet (no 4K / request limits / issues / notifications / watchlist — deferred).

## Key decisions

### Persistence — introduce a datastore (the app is currently stateless)
**Considered:** `node:sqlite` (built-in, zero-dep) · Postgres · an ORM (Prisma/Drizzle).
**Rejected:** `node:sqlite` is still experimental in Node 22 (API-churn risk for our system of record);
Postgres is another container for a single-household app; ORMs add weight/deps for a tiny schema.
**Chosen:** **better-sqlite3** — single-file SQLite, synchronous, mature, ships prebuilt binaries so the
linux-x64 Docker build needs no compiler (the Dell is x64). One sanctioned new dependency. In prod the DB
file lives on a mounted volume (persist across deploys). Wrap it behind a small data-access module so the
rest of the app never touches SQL directly and the layer stays unit-testable.

### Approvals — mirror Seerr
Reuse the Seerr permissions we already read at login. A request **auto-approves** if the user is admin
(`permissions & 2`) or has an auto-approve bit (Seerr `AUTO_APPROVE=128`, `AUTO_APPROVE_MOVIE=256`,
`AUTO_APPROVE_TV=512`); otherwise it is `pending` until an admin approves. Admin approve/decline transitions it.

### Coexistence — run alongside Seerr; Seerr stays the auth/permission backend
tyflix-web owns only the NEW request pipeline + its DB. Login/permissions still come from Seerr (unchanged).
Do **not** migrate Seerr's existing requests/users yet. Retiring Seerr is a later, separate decision once
tyflix-web is at parity. Requests created here go straight to Radarr/Sonarr; Seerr's own requests are
independent (accept the small chance of a duplicate request during coexistence).

### External services
Radarr (movies) + Sonarr (TV) via their REST APIs (add + monitor + trigger search). TMDB for discovery.
On approval: Radarr keys on **tmdbId**; Sonarr keys on **tvdbId**, so resolve TVDB via TMDB `external_ids`.
Quality profile + root folder: fetch the lists from Radarr/Sonarr and use a configured default (env, or the
first/"any" profile) — MVP uses a sensible default, **not** a per-request chooser.

### Availability / status (MVP)
Coarse status: `pending → approved → processing → available` (+ `declined`). Availability MVP: check
Radarr/Sonarr (`hasFile` / episode file counts) and/or Plex on a periodic refresh. Real-time webhooks deferred.

## Architecture additions
- `server/src/db/` — better-sqlite3 connection + schema init (idempotent migrations) + a `requests` data-access module.
- `server/src/tmdb/client.ts` — search, trending, movie/tv detail (+ `external_ids` for tvdbId).
- `server/src/radarr/client.ts`, `server/src/sonarr/client.ts` — profiles, root folders, add movie/series, search.
- `server/src/routes/discover.ts` (requireAuth) — search / trending / detail from TMDB.
- `server/src/routes/requests.ts` (requireAuth; admin actions require admin) — create / list / approve / decline.
- `web/src/pages/` — Discover, MediaDetail, Requests (+ admin approval queue).
- config: `TMDB_API_KEY`, `RADARR_URL`/`RADARR_API_KEY`, `SONARR_URL`/`SONARR_API_KEY` (+ optional default profile/root ids).

### `requests` table (initial)
`id` (pk), `tmdb_id`, `media_type` ('movie'|'tv'), `title`, `seasons` (JSON, tv only),
`requested_by_seerr_id`, `requested_by_name`, `status`, `radarr_id`/`sonarr_id` (nullable),
`created_at`, `updated_at`, `decided_by` (nullable), `decided_at` (nullable).

## Increment plan
- **5.1** — Persistence foundation: better-sqlite3, schema init, `requests` data-access module + `node:test`.
- **5.2** — TMDB client + discovery endpoints (search / trending / detail) behind `requireAuth` (+ tests).
- **5.3** — Discovery UI: search + trending grid + media detail page.
- **5.4** — Request submit + approval backend: create (auto-approve per Seerr perms, else pending), admin
  approve/decline, Radarr/Sonarr add + search on approval (+ tests with stubbed clients).
- **5.5** — Requests UI: request button on detail, "My requests" list, admin approval queue.
- **5.6** — Availability/status refresh (Radarr/Sonarr/Plex) reflected in the UI.
- Then **Phase 4** — deploy (now including the DB volume + TMDB/Radarr/Sonarr env + better-sqlite3 in the image).

## Not in scope (deferred)
4K requests, quality-profile chooser, per-user request limits, issue reporting, notifications, watchlist
sync, migrating Seerr's existing requests/users, retiring Seerr, real-time webhook availability.

## Prerequisites to gather
- **TMDB API key** — Tyler creates a free one at themoviedb.org (needed at 5.2).
- **Radarr + Sonarr URLs + API keys** — pull from the Dell like the Seerr key (needed at 5.4).
- Radarr/Sonarr default quality profile + root folder — read from their APIs when wiring 5.4.
