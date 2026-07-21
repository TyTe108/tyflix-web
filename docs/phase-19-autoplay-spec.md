# Phase 19 — Auto Play (next episode)

> Written up front 2026-07-20. Auto-advance to the next episode when one ends.
> Movies have no "next" — the toggle is TV-only.

## Design decision

**Considered:** carry the ordered episode list via router state from
EpisodeBrowser. **Rejected:** lost on refresh / direct URL nav → auto-play
silently stops working.

**Considered:** change the episode route to `/watch/tv/:tmdbId/episode/:ratingKey`
so WatchPage can reuse the existing `/api/watch/tv/:tmdbId/episodes` list.
**Rejected for now:** churns the route scheme + every episode link.

**Chosen:** a backend "next episode" resolver keyed on the episode ratingKey —
robust to any nav path, keeps the route stable.
`GET /api/watch/episode/:ratingKey/next → { nextRatingKey: string | null }`.
Backend: episode metadata → `grandparentRatingKey` (the show) →
`plexServer.episodes(show)` → sorted → the element after the current → its
ratingKey (null if last / not found / no grandparent). Frontend prefetches next
on episode load; on the video `ended` event, if Auto Play is on, navigates to
`/watch/episode/:nextRatingKey`.

## Decomposition

- **19.1 (backend)** — `plexServer.nextEpisode(episodeRatingKey)` +
  `GET /api/watch/episode/:ratingKey/next`. Unit-tested.
- **19.2 (frontend)** — Auto Play toggle in the settings gear (TV only, default
  ON, persisted in `localStorage`); prefetch next on episode load; on `ended` +
  toggle on → navigate to next.

## Not in scope

- Movie auto-play, an "up next" queue UI, or a countdown overlay — just a
  straight advance for now.
