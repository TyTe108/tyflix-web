# Phase 17 — Playback Settings (full parity)

> Written up front at kickoff (2026-07-19). Substantial feature: replace the
> native `<video controls>` with a custom Plex-style control bar + settings menu
> reaching full parity with Plex's PLAYBACK SETTINGS panel (Quality, Playback
> Speed, Audio, Subtitles + styling/offset, Auto Play).
>
> Scope confirmed by Tyler 2026-07-19: **FULL parity**. Build order across the
> streaming-parity epic: Phase 17 Settings → Phase 18 Resume → Phase 19 Casting.

## Goal

In-player playback settings at Plex parity: a custom control bar with a gear menu
offering Quality (bitrate/resolution), Audio track, Subtitles (on/off, track, and
color/size/position styling + offset), Playback speed, and Auto Play (next
episode).

## Current state (verified by reading the code 2026-07-19)

- `web/src/pages/WatchPage.tsx` uses native `<video controls autoPlay playsInline>`
  — no custom controls, no settings, no cast.
- `server/src/plex/transcodeUrl.ts` `buildHlsUrl` has NO
  bitrate/resolution/audioStreamID/subtitleStreamID/offset params — forces
  H.264/AAC only.
- `server/src/plex/server.ts` reads only title + file-size from
  `/library/metadata`; not the audio/subtitle `Stream` list, not duration, not
  `viewOffset`.
- The watch descriptor (`routes/watch.ts`) carries ratingKey, connections,
  transient, hls{local,remote}, sessionId — no streams, no duration.

## Design decisions

### D1 — Custom control bar vs keep native controls

**Considered:** keep `<video controls>` and float a settings panel over it.
**Rejected:** native controls can't host a Plex-style gear menu, and the
browser's native subtitle rendering can't be styled to parity; two competing
control UIs is worse UX.
**Chosen:** replace native controls with a custom control layer (transport, seek,
volume, fullscreen, gear). Required both for the gear menu and for styleable
sidecar subtitles.

### D2 — Subtitle rendering: burn-in vs sidecar

**Considered:** let Plex burn subtitles into the transcode (`subtitleStreamID`).
**Rejected:** burned-in subs can't be styled (color/size/position/offset) — that
is half of "full parity" — and every toggle/track change forces a transcode
restart.
**Chosen:** SIDECAR text subtitles — fetch the selected subtitle as WebVTT from
Plex and render as a cue layer styled client-side (no re-transcode to toggle,
switch, or restyle).
**Caveat (hybrid, honest):** sidecar only works for TEXT subs
(srt/ass/mov_text → VTT). Image subs (PGS/VOBSUB) can't become VTT → those fall
back to burn-in (transcode restart, unstyleable). The stream list flags which is
which (`textBased`).
**UNVERIFIED:** exact Plex endpoint/params to fetch a subtitle stream as VTT —
verify live before 17.7.

### D3 — Quality / Audio / image-subtitle changes: how to apply

These require a new transcode. **Chosen:** on change, tear down hls.js, rebuild
the stream URL with the new param, and resume at the current playback time via a
transcode `offset` (seconds) param. The "restart-at-offset" helper is shared with
Phase 18 (resume).
**UNVERIFIED:** the universal-transcode `offset` param name/behavior — verify live.

### D4 — Where stream metadata lives

**Chosen:** include `streams {audio[], subtitle[]}` + `durationMs` in the watch
descriptor (the player already fetches it once at play time). No separate endpoint.

## Increment decomposition (one concern each)

- **17.1 Backend — stream metadata in the descriptor.** Add `streams`
  (audio + subtitle track lists) + `durationMs` to the watch descriptor, read
  from Plex `/library/metadata/{ratingKey}` `Media→Part→Stream`. Backend only;
  verifiable via curl.
- **17.2 Backend — parameterize `buildHlsUrl`.** Optional `maxVideoBitrate`,
  `videoResolution`, `audioStreamID`, `subtitleStreamID`, `offset` (no-op when
  omitted; forced-H.264 behavior unchanged).
- **17.3 Frontend — custom control bar.** Replace native controls: play/pause,
  seek + time, volume, fullscreen, gear button. Transport parity, no settings yet.
- **17.4 Frontend — Playback speed** in the gear menu (client `playbackRate`).
- **17.5 Quality selection** (bitrate/res → restart-at-offset).
- **17.6 Audio track selection** (`audioStreamID` → restart-at-offset).
- **17.7 Subtitles — sidecar VTT** track + on/off + track selection
  (image-sub fallback = burn-in restart).
- **17.8 Subtitle styling** — color/size/position + offset + auto-sync
  (client CSS over the sidecar cue layer).
- **17.9 Auto Play** next episode (needs episode queue; ties to TV browse).

## Not in scope

- Resume from last position → **Phase 18**.
- Casting (Plex "Play on" + Google Cast) → **Phase 19**.
- HW transcode on the Arc A380 / remote bitrate cap → separate deferred item.

## Smoke test coverage at close

_(filled per increment as they close)_

## Live findings — 17.1 smoke test (2026-07-19, dev + real Plex)

`streams` + `durationMs` confirmed populated end-to-end against real Plex:
- **Movie** (Les Misérables, tmdb 82695): durationMs 9,478,571 (~158 min); 1 audio
  (aac 5.1); 5 subtitles, all `srt` → `textBased:true`, with titles (English CC,
  English SDH, Spanish, French Canadian, Portuguese).
- **Episode** (Severance S1E1, rk 2517): durationMs 3,436,724 (~57 min); 1 audio
  (eac3 5.1); 3 subtitles, all `pgs` → `textBased:false`.

Validated: the `textBased` heuristic is correct on real data (srt→true, pgs→false);
Media[0]/Part[0] scoping yields clean single stream-sets; durations match runtimes.

**Refinements for later increments:**
- **`external` is false for ALL subs in this library** — text subs are EMBEDDED
  (in-container srt), not sidecar files. So 17.7 must gate the sidecar-VTT path on
  **`textBased`, not `external`**, and be able to extract an *embedded* text sub to
  VTT. (The exact Plex endpoint for embedded-text→VTT is still UNVERIFIED — confirm
  live in 17.7.)
- **Image subs (PGS) are common in TV** — Severance's are all PGS → they hit the
  burn-in fallback and CANNOT be styled. Subtitle styling (17.8) is therefore
  text-sub-only in practice; image-sub titles get burned-in, unstyleable subs.
  Inherent to bitmap subtitles, not a bug — set expectations accordingly.

## Decomposition revision (2026-07-19)

- **17.3.1** — fix: clicking the video to dismiss the open settings panel also toggled play/pause (media click-to-play overlapped the outside-click close). Media click, when the panel is open, closes it without toggling.
- **17.5 split** for surgical, independently-verifiable increments:
  - **17.5 (backend)** — the `/movie/:tmdbId` and `/episode/:ratingKey` watch endpoints accept optional `maxVideoBitrate`/`videoResolution`/`offset` query params → threaded into `buildHlsUrl` (already param-ready from 17.2). Invalid values → 400. Unit-tested + curl-verifiable, no UI.
  - **17.6 (frontend)** — Quality settings group + the reusable **restart-at-offset** flow: capture `currentTime`, refetch the descriptor with the chosen bitrate/resolution + `offset`, tear down and rebuild hls, resume. First live test of the `offset` param (UNVERIFIED since 17.2).
- Downstream shift: **17.7** Audio, **17.8** Subtitles (sidecar), **17.9** Subtitle styling, **17.10** Auto Play. The restart-at-offset flow from 17.6 is reused by 17.7/17.8 (audio/subtitle change = same restart, different param).

### 17.6 design note (supersedes the "restart-at-offset" wording above)

- **Resume via client-side seek, NOT the `offset` param.** On a quality switch, rebuild the stream at full length (no `offset`) and set `video.currentTime` to the saved position — reusing the same seek path the seek bar uses. Keeps `currentTime` absolute (seek bar unaffected), reuses proven machinery, and avoids depending on `offset`'s still-unverified behavior/`currentTime` semantics. **`offset` verification moves to Phase 18** (resume-from-last-watched), where it's the natural fit for an initial start position.
- **CRITICAL: the restart must not unmount the `<video>`.** PlayerControls binds its media-event listeners to the specific video element instance (effect keyed on the stable `videoRef`, so it does NOT rebind if the element is replaced). A quality change therefore updates the descriptor + rebuilds hls **in place** — it must not flip status to `loading` or null the descriptor (either unmounts the video and breaks the controls). A pending `{ position, wasPlaying }` ref is applied once on the new manifest (hls `MANIFEST_PARSED` / native `loadedmetadata`), then cleared.
- Orphaned transcode: the old session is abandoned on switch (Plex times it out). An explicit stop call is deferred.

### 17.7 split (audio — mirrors the 17.5/17.6 quality split)

- **17.7 (backend)** — add `audioStreamID` to `parsePlayTuning` + `PlayTuning` + `WatchTuning` + `fetchWatch` (mirrors 17.5's params; `buildHlsUrl` already accepts it from 17.2). Unit-tested, no UI.
- **17.8 (frontend)** — Audio settings group (populated from `descriptor.streams.audio`) + generalize the restart to a COMBINED tuning so changing audio preserves the current quality (and vice-versa); resume via the same in-place rebuild as 17.6.
- Downstream shift: **17.9** Subtitles (sidecar), **17.10** Subtitle styling, **17.11** Auto Play. `subtitleStreamID` gets added to the backend when subtitles are built (17.9), same as audio here.

### 17.9 subtitle decision — BURN-IN (Tyler, 2026-07-19; supersedes D2 sidecar plan)

Live probe (Les Mis, srt subs, via a subtitleStreamID transcode request): the master playlist came back with ONLY a video `EXT-X-STREAM-INF` — no `TYPE=SUBTITLES` rendition — i.e. Plex **burns the subtitle into the video**. `subtitles=auto` → 400. So the styleable-sidecar path (D2) is NOT trivially available; a WebVTT rendition would need reverse-engineering Plex's subtitle-transcode profile params (fiddly, version-dependent, text-only). Tyler chose **burn-in**: functional parity (on/off + track selection, works for ALL sub types incl. PGS/image), no client-side styling/position/offset.

- **Subtitle styling (old 17.10) is DROPPED** — burned-in subs can't be styled.
- **17.9 (bundled backend + frontend)** — backend: add `subtitleStreamID` to `parsePlayTuning`/`PlayTuning`/`WatchTuning`/`fetchWatch` (mirror 17.7's audioStreamID). Frontend: a Subtitle group ("Off" + every `descriptor.streams.subtitle` track) extending `StreamSettings` to `{ quality, audioStreamId, subtitleStreamId }`; reuses the 17.8 combined-tuning restart so changing subtitle preserves quality + audio and resumes. Default = Off.
- **17.10** — Auto Play (next episode).
- Verify burn-in LIVE (screenshot: enable a sub → text visible on the picture). If `subtitleStreamID` alone doesn't burn, the fix is adding `subtitles=burn` to `buildHlsUrl` (small transcodeUrl change) — flagged, not assumed.

### 17.9.1 — subtitle burn fix (verified live 2026-07-19)

Smoke test of 17.9 failed: subtitle selected (English highlighted) but NOT visible on the picture → `subtitleStreamID` alone does not burn. Live probe on the transcode URL: **`subtitles=burn` → 200** (works); `subtitles=auto`, `subtitles=none`, and `directStream=0` all → **400** with our forced-H.264 profile. Fix: `buildTranscodeUrl` emits `subtitles=burn` whenever `subtitleStreamID` is set (keep `directStream=1`). Off (no `subtitleStreamID`) → no `subtitles` param. 17.9 + 17.9.1 commit together once burn-in is confirmed visible.

### 17.9 / 17.9.1 DEFERRED — subtitles blocked on transcode profile + HW (2026-07-19)

Smoke test failed twice (subtitle selected + highlighted, but not visible on the picture). Root cause, confirmed by curling Plex's `/video/:/transcode/universal/decision` directly (Mac→Dell LAN, admin token): with `subtitleStreamID=<id>&subtitles=burn`, Plex's decision returns ONLY the video (transcode) + audio (copy) streams — **the subtitle stream is absent entirely** (identical for `directStream` 0/1/omitted). So our minimal `X-Plex-Client-Profile-Extra` (declares only a video transcode target) makes Plex DROP the subtitle rather than burn it. Plex's own web client sends a fuller client profile that declares subtitle handling; replicating that is genuine reverse-engineering. And burn = full video re-encode → brutal cold-start on the CPU-only transcode (30s+ of black observed).

**Decision (Tyler, 2026-07-19): DEFER subtitles.** Shelve 17.9 + 17.9.1 (git stash). Phase 17 ships with **Speed + Quality + Audio** (all verified). Revisit subtitles after **HW transcode on the Arc A380** is enabled — that fixes both the slow cold-start and (with a proper transcode profile) most likely the drop. The shelved code is structurally correct (mirrors the audio flow); it needs the profile fix + HW transcode, not a rewrite. The shelved set also includes the `subtitleStreamID` backend param plumbing (route/client/buildHlsUrl) — re-apply when revisiting.

## Phase 17 status at close
Shipped + committed: 17.1 stream metadata, 17.2 transcode params, 17.3 custom control bar, 17.4 speed, 17.5 quality (backend), 17.6 quality (UI + restart), 17.3.1 dismiss fix, 17.7 audio (backend), 17.8 audio (UI + combined restart). Deferred: subtitles (17.9), Auto Play (17.10, optional). Native `<video controls>` fully replaced by a custom Plex-style control bar + gear menu with working Speed, Quality (bitrate/res, in-place restart-with-resume), and Audio-track selection.
