# Phase 18 — Resilient connection selection (fast-fail local → remote)

> Written up front 2026-07-20. Small, focused increment (one file: WatchPage.tsx).
> (Renumbers the earlier tentative "Phase 18 = resume-from-last-watched" → a later phase.)

## Problem

The watch player is handed two Plex connection URLs — LAN `plex.direct`
(`192-168-0-13…` → 192.168.0.13) and remote/WAN — and tries **local first**,
falling back to remote only on a *fatal* hls.js error. A remote viewer WITHOUT
Tailscale to `192.168.0.0/24` can't route to the private LAN IP, so hls.js hangs
on the local attempt for its default ~30s (timeout + retries) before failing
over → a long "stuck initializing" delay.

Diagnosed 2026-07-20: an external, non-Tailscale Mac Mini took "forever to
initialize" then streamed fine (once on remote); a Tailscale'd MacBook Air on
the same external network was instant (it reaches local via the Dell subnet
router). Server transcode is NOT the cause — HW transcode on the Arc A380 is
enabled (`HardwareAcceleratedCodecs="1"`, device `8086:56a5`); the delay is
purely client-side connection init.

## Design decision

**Considered:** race local + remote (attach both, use whichever connects first).
**Rejected:** fetching each `start.m3u8` starts a Plex transcode session, so
racing spawns TWO transcodes (2× server load) + more complex teardown.

**Considered:** pre-probe the local base (`/identity`) with a short fetch before
hls.js. **Rejected for now:** needs deriving the base + an extra request; more
moving parts than the minimal fix.

**Chosen:** give the LOCAL hls.js attempt a short **manifest** load timeout
(~3s) + minimal retries; on its fatal error, fall back to remote with hls.js's
normal (patient) timeouts. Reuses the existing single local→remote fallback,
just makes the dead wait short.

**Key nuance — fast-fail the MANIFEST only, never the fragments.** The master
manifest is the reachability signal: it returns in <1s when the connection is
reachable and hangs when it isn't. Do NOT shorten fragment/segment timeouts —
Plex segments are slow on a cold transcode *even when the connection is
perfectly reachable*, so a short fragment timeout would wrongly abandon a good
local connection. A 3s manifest timeout never trips for LAN/Tailscale clients.

## Not in scope

- Native-HLS path (Safari, `!Hls.isSupported()`) — it currently has no remote
  fallback at all; separate follow-up.
- Backend / connection resolver (already returns both URLs).

## Smoke test at close

_(fill at close — expect: non-Tailscale remote client falls to remote in ~3s,
Tailscale/LAN client still uses local and starts normally.)_
