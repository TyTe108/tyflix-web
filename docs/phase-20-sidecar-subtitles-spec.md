# Phase 20 — Sidecar subtitles (styleable text subs, Plex web's mechanism)

> Written 2026-07-20 after capturing what Plex web actually sends. Supersedes the
> earlier "burn-in" subtitle plan (17.9, shelved) — Plex web does NOT burn text subs.

## The finding (captured from app.plex.tv, Les Mis 4K HEVC, English CC sub on)

Plex web's video transcode request uses **`subtitles=auto`** with **NO
`subtitleStreamID` on the video URL** — it does not burn. The subtitle arrives via
a **separate, session-tied endpoint**:

```
GET /video/:/transcode/universal/subtitles?session=<same>&subtitles=auto&…  → 200
```

i.e. a **sidecar** — Plex delivers the selected text sub as its own stream
(WebVTT), the browser renders it client-side, and that's why Plex web's text subs
are **styleable** (size/position/color). The client profile-extra is all *video*
codec limits — nothing subtitle-specific; subtitle handling is `subtitles=auto` +
the `/subtitles` endpoint, not the profile. (My earlier "burn too slow on CPU" and
"profile doesn't declare subtitles" reasons were both wrong.)

**Not yet reproduced:** a quick sandbox mirror (HLS + minimal params +
`subtitleStreamID` on start) got `/subtitles` → 404. Plex web used DASH, a fuller
param set, and had already set the part's subtitle selection before play. Nailing
the exact selection call + sidecar params is the R&D in 20.1.

## Decision

**Sidecar, not burn.** It's Plex's actual mechanism for text subs and yields the
styleable subs originally wanted (the old 17.8 styling goal becomes trivial CSS
over a client-rendered track). **Image subs (PGS, common in TV) have no text
sidecar → burn fallback**, unstyleable, accepted.

## Decomposition

- **20.1 (R&D spike, sandbox-only)** — reproduce Plex web's flow via curl from the
  Mac (admin token, non-redacted): determine how the subtitle stream is selected
  (part `PUT /library/parts/:id?subtitleStreamID=…` vs a transcode param) and the
  exact `/subtitles` params that return **WebVTT** for a running session. Deliverable:
  a documented, working curl sequence (start transcode `subtitles=auto` → fetch
  WebVTT). This is the uncertain step; everything after is mechanical.
- **20.2 (backend)** — a tyflix route that returns the WebVTT for a play session
  (mint transient / proxy the `/subtitles` fetch), gated by auth.
- **20.3 (frontend)** — transcode with `subtitles=auto` (drop `subtitles=burn`);
  fetch the sidecar WebVTT; render it as a `<track>`/cue layer; re-wire the Subtitle
  group (reuse the shelved 17.9 UI). Text subs only; PGS → burn fallback.
- **20.4 (frontend)** — subtitle styling: color / size / position / offset via CSS
  over the cue layer (the original 17.8 goal).

## Risk / notes

- 20.1 is the only uncertain part; verification is now easy (HW transcode on the
  Arc A380 is fast + engaging — h264_vaapi ~16% CPU — so screenshots + iteration
  are quick, unlike the earlier CPU-cold-start freezes I wrongly blamed).
- Shelved 17.9 code (`git stash`) still has the Subtitle group UI + `subtitleStreamID`
  plumbing — partly reusable for 20.3.
