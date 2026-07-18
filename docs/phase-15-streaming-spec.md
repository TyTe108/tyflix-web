# Phase 15 — Playback (direct play via Plex)

> Written up front 2026-07-17, **before implementation** — implementation
> DEFERRED by Tyler (focusing elsewhere). This is the design + decision record so
> the increment can be picked up cold. Chosen approach: **Option 1 — direct play
> + Plex transient token** (decided 2026-07-17). Once shipped, the live
> architecture summary belongs in HANDOFF §3; this doc is the "why".

## Goal

Add in-browser video playback to tyflix-web — the **first feature that goes
beyond Seerr parity** (Seerr is a request manager with no playback). A user
presses **Play** on an available title and streams it in the browser, sourced
**directly from Plex** (bytes never traverse the Cloudflare tunnel). Broken into
four increments: 15.1 authorize a session, 15.2 play-decision endpoint, 15.3
player UI, 15.4 progress/resume.

## Context / how it fits

- tyflix-web is a **Seerr-backed enhancement**; playback is net-new, not parity.
- **Video must bypass Cloudflare** — its CDN service-specific terms prohibit
  serving significant video on non-enterprise plans. Direct Plex Remote Access is
  **live + verified** (2026-07-17): private `<SERVER_LAN_IP>:32400` ← public
  `<PUBLIC_WAN_IP>:32400`, manual port-forward, "Fully accessible outside your
  network". Browsers connect straight to `<id>.plex.direct:32400`.
- Admin (Tyler) holds an **active Plex Pass** → the post-Apr-2025 remote-playback
  restriction is satisfied for **all** shared users, direct or relay, free.
- External facts (verified 2026-07-17):
  - Relay fallback is capped ~2 Mbps (Plex Pass) / 1 Mbps (free) — SD only,
    unusable for HD. A **direct** connection is mandatory; relay-only must fail
    loud, never silently serve SD. [Plex Support: Relay]
  - Transient token: `GET /security/token`, ~48h TTL, dies on server restart,
    **same access level** as the source token. [Plexopedia]
  - Transient→permanent escalation bug affected PMS ≤ **1.42.2.10156** — the
    server must be patched past it. [Plexopedia]

## Design decisions

### Decision 1 — video transport (where the bytes flow)

**Considered:** (A) backend proxies the stream out through the Cloudflare tunnel;
(B) dedicated non-Cloudflare stream host on the Dell behind tyflix-issued signed
URLs; (C) direct play, browser ↔ Plex via `plex.direct`.

**Rejected — A:** video through Cloudflare's CDN violates non-enterprise ToS
under sustained multi-user load, and puts all transcode + egress on the
Dell/tunnel. (Tyler: "Not 2 definitely.")

**Rejected — B:** keeps the token fully server-side *and* video off Cloudflare,
but is the **most to build** (new public host + TLS + signed-URL scheme) — cuts
against "integrate existing tools, don't build from scratch." Retained as the
fallback if token-in-browser (Decision 2) is ever unacceptable. B does **not**
skip Plex — Plex still stores/transcodes/serves; B only inserts a data-path proxy.

**Chosen — C:** direct play. Uses Plex's own tooling end-to-end — the exact
mechanism app.plex.tv uses (transcode-decision → universal HLS → `plex.direct`).
Least new code, **scales** (Plex transcodes + delivers per-client; the Node app
is not in the video path), bypasses Cloudflare, free under Plex Pass, and reuses
the existing 32400 port-forward.

### Decision 2 — token custody (load-bearing)

**Problem:** direct play requires the browser to present a Plex token to the
server, but HANDOFF's model is "Plex token server-side only; browser holds only
the opaque session cookie." Playback must also be attributed to the **user**
(watch history, resume, the watched-vs-requested analytics) → it must use the
*user's* token, not the owner's.

**Considered (a):** put the user's **durable** Plex token in the browser (what
app.plex.tv does). **Rejected:** exposes a full-access, long-lived credential to
the browser; largest XSS blast radius; hardest reversal of the posture.

**Considered (b):** use the **owner/server** token for all playback.
**Rejected:** every stream logs as the owner → breaks per-user watch history, the
analytics, and per-user semantics. Non-starter.

**Chosen (c):** mint a **transient token server-side from the user's token** and
hand only that to the browser. ~48h TTL, dies on restart, correctly per-user. The
durable token still never leaves the backend — a deliberate **extension** of the
token model, not a break of it.

**Sub-decision — where the user's durable token lives at play time.** The session
cookie is a stateless signed blob; Phase 14 pushes the token into Seerr (not
readable back via API). **Considered:** encrypt the user's Plex token into the
signed session cookie (httpOnly/Secure) vs a small server-side session store keyed
by the cookie id. **Chosen (proposed — confirm):** encrypt-in-cookie for zero new
infra, behind a `TokenStore` seam so it can move to a server-side store later.

**Prerequisite:** PMS patched past 1.42.2.10156 (else a transient token can be
escalated to a permanent one).

### Decision 3 — resolving the playable Plex item (ratingKey)

tyflix discovery is TMDB-keyed; Plex is `ratingKey`-keyed. Seerr's media records
(the same `/api/v1/media` data `mediaStatusProvider` already paginates) carry
`ratingKey` for available items.

**Considered:** query Plex directly (search by title/GUID) vs reuse Seerr's
`media.ratingKey`. **Rejected — direct Plex search:** redundant, fuzzy title
matching, inconsistent with "Seerr is the source of truth."

**Chosen:** extend the media provider to surface `ratingKey` alongside status
(`mediaType:tmdbId → { status, ratingKey }`). Only **available** items
(`media.status ∈ {4,5}`) are playable; anything else fails loud (404/409).

**Verify-live caveat:** confirm this Seerr build's `/api/v1/media` returns
`ratingKey` — the culture here is verify-against-the-live-instance (the source has
diverged before, e.g. the issue API).

### Decision 4 — external connection discovery

**Chosen:** `GET https://plex.tv/api/v2/resources?includeHttps=1` (token in
header) → match the server by `machineIdentifier` → pick the connection with
`local=false, relay=false` (the `plex.direct` HTTPS URI on the public IP). **Fail
loud** if only a relay connection is available rather than serving 2 Mbps SD.

### Decision 5 — player library

**Considered:** plain hls.js + native `<video>` controls vs **Vidstack** (wraps
hls.js; adds a control bar, subtitle/quality/resume UI). **Chosen:** decide at
15.3 — lean Vidstack for the free UI (integrate-don't-build), but it is a **new
dependency → must be flagged** per the workflow. Minimal first cut = hls.js +
native controls.

## Increment plan

- **15.1 — Authorize a playback session (backend).** Connection discovery
  (Decision 4) + transient-token minting (Decision 2c) + token custody (capture
  the user's Plex token at login; `TokenStore` seam). One concern.
- **15.2 — Play-decision endpoint (backend).** `GET /api/watch/:mediaType/:tmdbId`
  (requireAuth) → resolve ratingKey (Decision 3) → request a Plex transcode
  decision → return `{ streamBaseUrl, transientToken, hlsUrl, ratingKey }`. Fail
  loud on unavailable / relay-only.
- **15.3 — Player page + Play button (frontend).** New `/watch/:mediaType/:tmdbId`
  route with an hls.js/Vidstack player; a **Play** affordance on `MediaDetailPage`
  for available items only; loading/error/back.
- **15.4 — Progress + resume.** Periodic `GET /:/timeline?state=…&time=…` pings so
  Plex records history + supports resume. **Bonus:** generates the Plex watch
  history the existing watched-vs-requested analytics read — watching *through*
  tyflix finally feeds its own numbers.

## Not in scope (deferred or rejected)

**Deferred (candidate later):** direct-play passthrough for browser-compatible
files (skip transcode for h264/aac-mp4); subtitle + multi-audio selection; client
quality cap / adaptive bitrate; a "Continue Watching" rail (builds on 15.4);
Cast/Chromecast; offline downloads.
**Rejected:** transports A and B (Decision 1); owner-token playback (Decision 2b).
**N/A:** 4K playback — no 4K server.

## Operational prerequisites (config, not code)

- Enable/verify **Plex hardware transcoding on the Arc A380** (renderD129),
  unlocked by Plex Pass — else concurrent browser transcodes hammer the Dell CPU.
- **Update PMS past 1.42.2.10156** (transient-token escalation bug).
- Verify PMS returns permissive **CORS** on transcode endpoints from the tyflix
  origin (generally yes; confirm at 15.2/15.3 smoke test).

## Smoke test coverage at close

_None yet — design only, implementation deferred 2026-07-17._

## Files (anticipated; not yet touched)

| File | Anticipated change |
|---|---|
| `server/src/plex/connection.ts` (new) | resources discovery → direct `plex.direct` URI; fail-loud on relay-only |
| `server/src/plex/transientToken.ts` (new) | mint transient token from a user token |
| `server/src/session.ts` | carry/retrieve the user's Plex token (`TokenStore` seam) |
| `server/src/routes/auth.ts` | capture the user's Plex token at login into the store |
| `server/src/seerr/mediaStatusProvider.ts` | surface `ratingKey` alongside status |
| `server/src/routes/watch.ts` (new) | `/api/watch/:mediaType/:tmdbId` decision endpoint |
| `web/src/api/watch.ts` (new) | typed client for the decision endpoint |
| `web/src/pages/WatchPage.tsx` (new) | hls.js/Vidstack player |
| `web/src/pages/MediaDetailPage.tsx` | Play button for available items |
| `web/src/App.tsx` | `/watch/...` route inside the app shell |

## Status

**DESIGN ONLY.** Chosen: Option 1 (direct play + transient token). Implementation
deferred by Tyler 2026-07-17 (focusing on other work). Pick up at 15.1.

## References (external, verified 2026-07-17)

- Plex transient token — https://www.plexopedia.com/plex-media-server/api/server/transient-token/
- Universal transcode (HLS) — https://plexapi.dev/api-reference/video/start-universal-transcode
- Relay (direct vs relay, bandwidth cap) — https://support.plex.tv/articles/216766168-accessing-a-server-through-relay/
- Remote playback requires Plex Pass; admin covers all users — https://www.plex.tv/blog/important-2025-plex-updates/
