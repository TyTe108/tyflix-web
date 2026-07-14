# Phase 1 — Plex login + Seerr-backed role gate

> Written up front (auth is substantial and load-bearing). Prereq: Phase 0 scaffold
> reviewed and smoke-tested. Facts here are verified against primary sources (see end).

## Goal

Let a Plex user sign in through our app, confirm they are a real Seerr user, mirror their
Seerr permissions to decide admin vs regular, and hold that identity in **our own** session.
After this phase: `GET /api/auth/me` returns the current user + `isAdmin`; unauthenticated
requests to protected routes are rejected; logout clears the session.

## Design decisions

### Decision 1 — Session ownership

**Considered:** Ride Seerr's own session — POST the Plex `authToken` to Seerr
`/api/v1/auth/plex`, capture its `connect.sid`, and proxy every call as that user.

**Rejected:** Couples us to Seerr's cookie lifetime and domain; forces per-user Seerr
sessions through our backend; awkward across two hostnames; and it inverts the
"standalone, replacement-later" direction (we'd depend on Seerr for *our* sessions).

**Chosen:** Our backend mints its **own** signed session cookie after verifying the user.
Seerr is an *identity/permission source*, not our session authority. Clean seam for the
eventual replacement (swap the identity source for our own user store; sessions unchanged).

### Decision 2 — How we read the user's role

**Considered:** `POST /api/v1/auth/plex { authToken }` to have Seerr resolve the user, then
`GET /api/v1/auth/me` for permissions.

**Rejected:** `auth/plex` has **side effects** — it creates/updates users and, if no users
existed, mints a full admin. It also needs the user's Plex token to leave our control into
Seerr and returns a session we don't want. Overkill for a read.

**Chosen:** After Plex tells us the account id, call `GET /api/v1/user` with our
**server API key** and match the logged-in user by `plexId`. Read `permissions` from that
record. No mutations, no per-user token forwarding, uses the key the dashboard already uses.
`isAdmin = (permissions & 2) !== 0` (`Permission.ADMIN`).

### Decision 3 — Authorization boundary (who may log in at all)

**Considered:** Allow any valid Plex account to log in; only gate *admin* features.

**Rejected:** App is public and surfaces personal request/watch data; a random Plex account
should not get a session.

**Chosen:** A user may sign in **iff** they resolve to an existing Seerr user (found by
`plexId`). No Seerr user ⇒ 403, no session. This reuses Seerr's membership as our door.

### Decision 4 — Where the Plex PIN flow runs

**Considered:** Frontend generates and polls the PIN, then hands the `authToken` to the backend.

**Rejected:** Exposes the Plex `authToken` to browser JS.

**Chosen:** Backend generates the PIN and returns only `{ pinId, code, authUrl }`; the frontend
opens `authUrl` in a popup and polls **our** `/api/auth/plex/check?pinId=`. The backend polls
Plex, and on success does who-am-I → Seerr lookup → sets our session cookie. The Plex token
never reaches the browser.

### Decision 5 — Session mechanism

**Chosen:** Signed, `httpOnly`, `Secure`, `SameSite=Lax` cookie. Payload minimal:
`{ seerrUserId, plexId, permissions, iat, exp }`, signed with a server secret (stateless is
fine for a solo/small deploy; a server-side store can come later if we need revocation).
Re-fetch permissions from Seerr on login (and optionally refresh on a TTL) so role changes
in Seerr propagate.

## Endpoints (backend)

- `POST /api/auth/plex/start` → creates a Plex PIN. Returns `{ pinId, code, authUrl }`.
- `GET  /api/auth/plex/check?pinId=` → polls Plex for that pin. While pending: `{ status: "pending" }`.
  On success: resolve Plex account → Seerr `plexId` lookup → set session cookie →
  `{ status: "ok", user }`. If the Plex user is not a Seerr user: `403 { status: "forbidden" }`.
- `GET  /api/auth/me` → `{ user: { seerrUserId, plexId, displayName, plexUsername, email,
  avatar, permissions }, isAdmin }` or `401` if no valid session.
- `POST /api/auth/logout` → clears the cookie.
- Middleware: `requireAuth` (valid session) and `requireAdmin` (`permissions & 2`). All future
  `/api/admin/*` routes use `requireAdmin`; the client is never trusted for this.

## Frontend

- **Login page:** "Sign in with Plex" → calls `start`, opens `authUrl` popup, polls `check`.
  Shows pending, success (redirect), and the forbidden case ("Your Plex account isn't a Tyflix
  member") distinctly.
- **Session context + `ProtectedRoute`:** loads `/api/auth/me` on boot; redirects to login if
  401. An `AdminRoute` variant additionally requires `isAdmin` (defense in depth; server still enforces).
- **Nav:** show the Admin area link only when `isAdmin` — but this is cosmetic; the gate is server-side.

## Acceptance criteria (observable behavior)

- Visiting any protected page while logged out redirects to the login page; `/api/auth/me`
  returns 401.
- Completing the Plex popup as a **regular** Tyflix user lands on the user dashboard;
  `/api/auth/me` shows `isAdmin: false`; hitting an `/api/admin/*` route returns 403.
- Completing it as the **owner/admin** shows `isAdmin: true` and admin routes return 200.
- A Plex account that is **not** a Seerr user is rejected with a clear message and gets **no**
  session cookie.
- Logout clears the cookie; `/api/auth/me` returns 401 afterward.
- The Plex `authToken` never appears in any response body, browser storage, or client network
  log — only the opaque session cookie is set.

## Fail-loud requirements

- Missing/blank required env (Seerr URL, Seerr API key, Plex client id, session secret) ⇒
  backend refuses to start with a clear error. No silent defaults for secrets.
- Seerr unreachable or returning non-2xx during login ⇒ surface an explicit
  "can't verify membership right now" error (HTTP 502), do **not** grant a session.
- PIN expired/denied ⇒ explicit failure state on the login page, not an infinite spinner.
- No permission = admin fallback. If permissions can't be read, deny (never default to admin).

## Out of scope (deferred)

- Watched-vs-requested analytics (Phase 2) and any admin metrics (Phase 3).
- Request/browse features (replacement path, Phase 5+).
- Server-side session store / revocation, refresh tokens (candidate later).
- Rate limiting / Cloudflare Access hardening (do in/around Phase 4 before public routing).

## Smoke test coverage (to record at close)

- [ ] Logged-out redirect + 401.
- [ ] Regular user: login OK, `isAdmin:false`, admin route 403.
- [ ] Owner: login OK, `isAdmin:true`, admin route 200.
- [ ] Non-Seerr Plex account: rejected, no cookie.
- [ ] Logout clears session.
- [ ] Confirm (devtools) the Plex token never reaches the browser.

## Verified facts (sources)

- Plex PIN flow: `POST clients.plex.tv/api/v2/pins` + `X-Plex-Client-Identifier`; authorize at
  `app.plex.tv/auth#?clientID=&code=`; poll `GET /api/v2/pins/<id>` for `authToken`.
- Seerr `POST /api/v1/auth/plex` accepts `{ authToken }`, sets `connect.sid`, creates a first
  admin if no users exist. (Overseerr/Seerr API spec.)
- `Permission.ADMIN = 2`; `hasPermission` returns true for any check when the ADMIN bit is set.
  (`server/lib/permissions.ts`, seerr-team/seerr.)
- Seerr `GET /api/v1/user` returns `User` objects; the `User` schema carries both `plexId` and
  `permissions` (confirmed in the Overseerr OpenAPI spec). A per-user detail path
  `/api/v1/user/{id}` also exists if ever needed. (Tyflix dashboard `app/main.py` uses the list
  endpoint; requests carry `media.ratingKey`.)
- `auth/plex` note: a Plex user with access to the main server gets a Seerr account created
  **without any permissions** — i.e. a shared user defaults to a regular (non-admin) user, which
  is exactly what our gate expects. (Overseerr OpenAPI spec.)
