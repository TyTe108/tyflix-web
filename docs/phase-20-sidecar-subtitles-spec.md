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

## 20.1 spike results (2026-07-20) — partial; sidecar recipe still not reproduced

Used the uploaded Plex OpenAPI (`docs/openapi.json`, 1.3MB — documents `/transcode/universal/{decision,start,subtitles}`, `/library/streams/{id}.{ext}`, `/library/parts/{id}`).

**Confirmed:**
- **Subtitle selection** = `PUT /library/parts/{partId}?subtitleStreamID={id}` → 200 (`subtitleStreamID=0` deselects). partId from `/library/metadata/{rk}` → `Media[0].Part[0].id` (Les Mis 6094 → part 10352, English CC stream 55063).

**Ruled out:**
- `GET /library/streams/{streamId}.{ext}` (.vtt/.srt) → **501** for our EMBEDDED subs. That endpoint serves only EXTERNAL sidecar *files*; embedded subs must be extracted via the transcode pipeline. (Confirms no session-less shortcut for this library.)

**Still blocked — the sidecar `/video/:/transcode/universal/subtitles`:** Plex must DECIDE to emit a sidecar within a valid session, and reproducing that from a standalone curl fails:
- HLS + our minimal h264 profile + `subtitles=auto` (part pre-selected) → `/subtitles` **404** (Plex produced no sidecar).
- DASH, even with Plex web's *captured* `X-Plex-Client-Profile-Extra` + `X-Plex-Product=Plex Web` → `start.mpd` **400**.
- Root cause: Plex web sends a full client context (its registered Plex-Web client-id + `X-Plex-Device/Model/Features/Playback-Id/-Session-Id` headers) that a from-scratch curl doesn't replicate, so Plex 400s the decision or won't sidecar.

**Two real ways forward (both non-trivial):**
1. Capture Plex web's FULL request *including the X-Plex-\* HEADERS* (browser devtools, not just the URL) → exact recipe → translate to tyflix.
2. Build the part-select + `subtitles=auto` + `/subtitles` fetch into tyflix's real client flow and iterate against `/decision` (tyflix's own client identity + hls.js) until Plex agrees to sidecar.

**Assessment:** direction (sidecar, styleable) is confirmed real; the exact recipe is genuinely finicky R&D and the standalone spike didn't crack it.

---

## PIVOT (2026-07-20): burn-in confirmed working — SUPERSEDES the sidecar plan above

Live evidence (Plex web captured via Claude-in-Chrome on app.plex.tv + direct
`/video/:/transcode/universal/decision` probes on our own flow) flips the plan.

**Finding 1 — Plex web BURNS (does not sidecar) for transcoded video.** Plex web's
own transcode of Les Mis (4K HEVC) used `protocol=dash&subtitles=burn`, and there
was NO `/transcode/universal/subtitles` request in the full 105-request capture.
The earlier "sidecar / `subtitles=auto`, styleable, no burn" premise was a misread.
For any source whose video is transcoded — i.e. ALL of tyflix (we force H.264) —
Plex burns.

**Finding 2 — the confirmed recipe (our exact HLS + forced-H.264 path):**
1. SELECT the sub on the part, server-side: `PUT /library/parts/{partId}?subtitleStreamID={id}`
   (200; `=0` turns off). partId = the metadata's `Media[0].Part[0].id`.
2. BURN it in the transcode: `start.m3u8?…&subtitles=burn`.
Verified via `/decision`: PUT + `subtitles=burn` → the sub is `decision=burn,
burn=1, selected=true` (burned into `segments-av`). PUT but NO `subtitles=burn` →
`decision=transcode` (not burned). NO PUT (URL `subtitleStreamID` only) → the sub
isn't selected at all. So BOTH the PUT and `subtitles=burn` are required; the URL
`subtitleStreamID` param is NOT the selector — exactly why 17.9 (URL param, no
PUT) "didn't work."

**Shelved 17.9 stash:** its `subtitles=burn` line + Subtitle-group UI +
`formatSubtitleLabel` are reusable, but it is MISSING the part-selection PUT (it
relied on the URL `subtitleStreamID`, which doesn't select) and predates the Phase
19/21 PlayerControls/WatchPage changes — so adapt it, don't `stash apply`.

**Trade-off accepted:** burned subs are baked into the video → not client-styleable
(the old 17.8 size/color goal is dropped for burn). Zero client rendering needed.
ALL subtitle tracks are selectable (image PGS subs burn too, not just text).

### New decomposition (burn)

- **20.1 (backend) — selection + burn.** (a) expose `partId` on the play descriptor
  (from `playbackMeta`'s `Media[0].Part[0].id`); (b) an auth-gated route to select
  the sub for the current user (resolve partId → `PUT /library/parts/{partId}?subtitleStreamID={id|0}`
  with the USER's Plex token); (c) `buildHlsUrl` always emits `subtitles=burn`
  (harmless with nothing selected). Unit-tested + live-verified via `/decision`.
- **20.2 (frontend) — Subtitle UI.** A **Subtitles** group in the settings gear (Off
  + one per `descriptor.streams.subtitle`, reusing the stash's `formatSubtitleLabel`).
  Selecting → call the 20.1 route → combined-tuning in-place restart (same as
  Quality/Audio). Live-verify a burned sub appears in-browser.

### To confirm during 20.1
- That the part-PUT with the user's token is honored by the transcode session (which
  uses the user's transient — same account, so expected). If not, fall back to the
  owner token (documented side effect: mutates the owner's per-item selection).
- Whether `subtitles=burn` is safe to emit always (appears so) vs only when selected.
