# Phase 21 — "Up Next" overlay + countdown

> Written up front 2026-07-20. Extends Phase 19 Auto Play (today: a **silent**
> advance on the video `ended` event only — no overlay, no countdown, no manual
> control). Carried over from Phase 19 and fixed: **TV-only** (movies have no
> "next") and gated by the existing **Auto Play toggle** (`localStorage`
> `tyflix.autoPlay`, default ON). See `docs/phase-19-autoplay-spec.md`.

## Goal

Turn the silent end-of-episode auto-advance into a visible, Plex-style **"Up
Next"** card near the end of an episode: a **thumbnail** + "Up Next · SxEy ·
Title" + a **countdown**, with a **Play now** button (skip ahead immediately)
and a **Dismiss** button (cancel the advance for this episode).

## Design driver — match Plex's own behavior

Tyler's scope answers were "whatever Plex uses" (advance timing) and "the
standard convention" (dismiss). Per Plex Support docs, Plex's defaults are:

- The Up Next card is triggered by the item's **credits marker** (`type:
  "credits"`, `startTimeOffset`/`endTimeOffset` in **ms**). Where a credits
  marker is absent, Plex falls back to the end-of-item post-play screen.
- Plex **keeps playing through the credits** and **auto-advances to the next
  item on a countdown** unless the user interacts with the screen — interacting
  cancels the timer.
- Skipping the credits themselves is a **manual** button by default (Plex does
  not auto-jump past credits unless you set it to).

Sources: Plex Support — "Play Queue Post-Play Screen"
(support.plex.tv/articles/202605013-play-queue-post-play-screen/) and
"Settings: Plex for Roku" (support.plex.tv/articles/204275243-settings-plex-for-roku/).

## Key design decisions

### When the card appears

**Considered:** a fixed lead time (e.g. last 30s) for every episode.
**Rejected as the primary trigger:** ignores Plex's marker data — the card would
pop mid-scene on episodes with long credits and feel un-Plex-like.
**Chosen:** trigger at the current episode's **credits marker `startTimeOffset`**
(from Plex, ms → compare to `video.currentTime`). **Fallback** when there is no
credits marker (or it can't be read): show the card in the final **30s**
(computed from `video.duration`). **Final fallback:** if duration is also
unknown, keep today's pure-`ended` advance with no card.

### When it auto-advances

**Considered:** advance early when a short fixed countdown (e.g. 10s) expires,
cutting off the tail of the credits.
**Rejected for now:** (a) Plex's default plays through credits and only *offers*
a manual skip; (b) a second advance trigger racing the existing `ended` handler
is a double-navigation risk. Kept as a future tuning option (see Not in scope).
**Chosen:** auto-advance stays on the video's **`ended`** event — the existing
Phase 19 handler, unchanged. The countdown visualizes time remaining until that
advance; **Play now** is the manual early-skip (mirrors Plex's Skip-Credits
button). One advance trigger, no race.

### Dismiss behavior

**Considered:** dismiss hides the card but the episode still auto-advances.
**Rejected:** surprising — a user who closes "Up Next" doesn't want the next one
to start; also contradicts Plex ("interact to cancel the timer").
**Chosen:** **Dismiss cancels the auto-advance for the current episode** — the
card hides and the `ended` handler is suppressed via a per-episode `dismissed`
flag, reset when the ratingKey changes.

### Card contents / thumbnail

**Chosen (Tyler picked "include the thumbnail"):** show the next episode's
**still image** (per-episode `thumb`, verified present on episode leaves, e.g.
`/library/metadata/2518/thumb/…`). The **frontend composes** the image URL —
`{connection}/photo/:/transcode?url=<episode thumb>&…&X-Plex-Token=<transient>`
— from the **current descriptor's** `transient` + working `plex.direct`
connection (both already in hand for playback) plus the next episode's raw
`thumb` path from `/next`. Requires a CSP `img-src` allowance for
`https://*.plex.direct:32400`.

**Considered:** have `/next` build the full `thumbUrl` server-side.
**Rejected:** `/next` has no token custody today and can't know whether the
browser is on the local or remote connection (it'd have to mint a transient and
return two URLs). The frontend already holds the transient + both connections +
which one is live, so it composes the URL; `/next` stays a pure metadata call.

## Decomposition (each = one Cursor prompt / one commit-sized change)

- **21.1 (backend route + FE type) — enrich `/next` with episode identity.**
  `GET /api/watch/episode/:ratingKey/next` currently returns only
  `{ nextRatingKey }`. `plexServer.nextEpisode` **already** returns the full
  `{ ratingKey, seasonNumber, episodeNumber, title }` — the route discards all
  but `ratingKey`. Widen the response to a `nextEpisode` object (or null) and
  update `fetchNextEpisode` to return it (soft-fail → null). No Plex-client
  change. **← first increment.**
- **21.2 (backend) — current-episode credits marker.** Add
  `creditsOffsetMs: number | null` to `playbackMeta` by fetching
  `/library/metadata/:ratingKey?includeMarkers=1` and parsing the `credits`
  `Marker.startTimeOffset`; thread through `PlayDescriptor` → `WatchDescriptor`.
  Fail-soft to null. **Verified live 2026-07-20** (Severance S1E1, ratingKey
  2517): `GET /library/metadata/2517?includeMarkers=1` returns
  `Marker: [{ type:"credits", startTimeOffset, endTimeOffset, final }]` — one
  credits marker, `final:true`, start 3347052ms of 3436724ms (≈ last 89s). So
  this server does generate credits markers and the marker-first trigger is
  valid. Caveat for 21.4: ~90s of credits → cap the *visible* countdown (show
  the card at the marker, but don't render a literal 89s counter).
- **21.3 (backend + CSP + FE type) — next-episode thumb path.** `episodes()`
  parses the leaf `thumb` (per-episode still, verified present); `PlexEpisode`
  and the FE `NextEpisode` + `parseNextEpisode` carry `thumb: string | null`;
  CSP `img-src += https://*.plex.direct:32400`. `/next` returns the raw `thumb`
  inside its existing `nextEpisode` object — it does NOT build the image URL or
  mint a transient (see the thumbnail decision above).
- **21.4a (frontend) — the overlay, time-triggered.** `overlay` slot in
  `PlayerControls` rendered **inside** `.watch-player-shell` (survives
  fullscreen); new `<UpNextCard>` (thumb with local→remote fallback, "SxEy ·
  title", countdown, Play now, Dismiss). WatchPage shows it in the final **30s**
  (autoPlay on, TV, a next exists, not dismissed), composes the thumb URL(s)
  from the current descriptor's transient + connections, Play-now navigates now,
  Dismiss hides. Does **NOT** touch the existing `ended` advance (still fires at
  end) → low risk, and committable + visible so we can verify
  thumb/CSP/positioning/fullscreen live.
- **21.4b (frontend) — marker trigger + real dismiss.** Switch the trigger to
  `creditsOffsetMs` (fallback last-30s); make **Dismiss cancel the auto-advance**
  for the episode (guard the `ended` handler with the per-episode dismissed
  flag); cap the visible countdown (~90s credits → show e.g. ≤20s). Reuses the
  `tyflix.autoPlay` toggle; TV-only.

## Not in scope (deferred or rejected)

- **Auto-skipping the credits** (advance before `ended`): **deferred** — see the
  auto-advance decision; a future toggle could add a short fixed countdown.
- **Movie / next-in-collection auto-play:** **deferred** — separate feature area.
- **A persistent "next episode" button in the control bar:** **rejected for
  now** — superseded by the overlay's Play-now; revisit only if a persistent
  control is wanted.
- **Per-user countdown-length / behavior settings:** **deferred** — defaults
  fixed this phase.

## Files expected to change

| File | Increment | Change |
|---|---|---|
| server/src/routes/watch.ts | 21.1 | widen `/next` response |
| web/src/api/watch.ts | 21.1, 21.2, 21.3 | next-episode object; `creditsOffsetMs`; `thumb` |
| server/src/plex/server.ts | 21.2, 21.3 | markers in `playbackMeta`; `thumb` in `episodes` |
| server/src/index.ts | 21.3 | CSP `img-src` `*.plex.direct` |
| web/src/components/PlayerControls.tsx | 21.4a | `overlay` slot inside the shell |
| web/src/components/UpNextCard.tsx (new) | 21.4a | the card UI (thumb, countdown, buttons) |
| web/src/styles.css | 21.4a | `.watch-upnext` card styles |
| web/src/pages/WatchPage.tsx | 21.4a/b | show/thumb/countdown/play-now/dismiss; then marker trigger + dismiss-cancels-advance |

## Smoke test coverage at close

- **21.1** (smoke-tested + passed 2026-07-20): Auto Play on → episode advances to
  the next at end; Auto Play off → stays put at end; last episode → no navigation
  and no error (`nextEpisode: null`). Also verified green pre-smoke: server
  172/172 tests (incl. the `/next` suite), `web` `tsc -b` clean.
- _21.2–21.4: fill in as each is smoke-tested before commit._
