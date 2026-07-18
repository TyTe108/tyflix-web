# Tyflix

Tyflix is a self-hosted web app that gives a Plex server a proper front door: browse and discover titles, request them in one click, and see what is already in the library, all behind a Plex sign-in.

It is built on top of Seerr, the request manager in the Overseerr and Jellyseerr family, which handles the pipeline into Radarr and Sonarr. Tyflix adds the parts that Seerr leaves thin for my use: a poster-forward browse-and-discover experience, per-user analytics, and an admin view of the server itself. The goal was a clean front end my household could use without ever touching the automation tools underneath.

**Live instance:** https://tyflix.tylerte.dev (signing in needs a Plex account with access to the server)

_Active project. Deployed and in daily use, and still being built out. The roadmap is at the bottom._

## Screenshots

Discover: browse global trending from TMDB, with live availability read from Plex.

![Discover page](docs/screenshots/discover.jpg)

Title page: artwork and details for a single movie or show.

![Title page](docs/screenshots/title-page.jpg)

Admin: manage requests that flow through to Radarr and Sonarr, with status and filters. Usernames here are demo labels.

![Admin requests](docs/screenshots/admin.jpg)

## What it does

- Browse and search movies and TV from TMDB: trending, browse by genre, recommendations, cast and crew, collections, and studio and network pages.
- Request a title in one click. Requests flow through Seerr into Radarr and Sonarr, which do the actual downloading and library management.
- Show real availability on every title (in the library, partially available, or still processing), read live from Plex through Seerr.
- Report a problem with a title, such as bad audio or the wrong cut, and follow it through to resolution.
- Plex Watchlist support, per-user request quotas, and quality-profile selection at request time.
- An admin area with system and storage metrics, running jobs, container health, user management, and a per-user "watched versus requested" view that shows how much requested content actually gets watched.

## Architecture

Tyflix is a single Node service. It serves a JSON API and the built React app from the same origin.

- **Frontend:** React, Vite, and TypeScript. A dark, poster-forward interface with a persistent sidebar.
- **Backend:** Node, Express, and TypeScript. It holds every credential and talks to four upstreams: Plex for accounts and the library, Seerr for requests and media status and issues, TMDB for discovery metadata and images, and a small host-metrics service for the dashboard.
- **Auth:** users sign in with their Plex account over Plex's PIN flow. The browser only ever holds a signed, httpOnly session cookie. The Plex token stays on the server.
- **Deployment:** the whole app runs in Docker on a home server, on the same Docker network as Seerr. It is reachable from anywhere through a Cloudflare Tunnel, so no inbound ports are open on the home network. TLS terminates at Cloudflare's edge.

```
Browser --https--> Cloudflare edge --tunnel--> cloudflared --> Tyflix (Node)
                                                                 |-> Seerr --> Radarr / Sonarr
                                                                 |-> Plex
                                                                 |-> TMDB
```

## Notable engineering decisions

**Public access with no open ports.** The app is hosted at home but reachable from anywhere. Instead of forwarding ports through the router, it runs behind a Cloudflare Tunnel: a small daemon on the server opens an outbound connection to Cloudflare, and traffic returns down that same connection. Nothing on the home network accepts unsolicited inbound traffic, and TLS plus edge protection come for free.

**Rate limiting that sees the real client.** Because the app sits behind the tunnel, every request arrives from the tunnel's address rather than the user's. A naive per-IP limiter would treat all traffic as one client. The limiter keys on the `CF-Connecting-IP` header that Cloudflare sets and overwrites, so a client cannot forge it, and falls back to the socket address for local development. The limit itself was tuned after a real finding: the admin dashboard polls a few endpoints every few seconds, and an early, tighter limit throttled the admin's own page inside a single window.

**Security that does not rely on hiding the code.** All authorization happens on the server. Every route checks the session, and admin routes check an admin permission bit that mirrors Seerr's model. The long-lived Plex token never leaves the backend. Security headers ship a Content-Security-Policy scoped to exactly what the app loads: posters from TMDB, fonts from Google, everything else same-origin. The one subtlety is the Plex login popup, which needs a Cross-Origin-Opener-Policy that lets the opener keep a handle on the popup so the sign-in flow can close it when the login completes.

**Video that bypasses the tunnel (designed).** Streaming video through Cloudflare would break its terms for non-enterprise plans, so the playback design has the browser connect straight to Plex over its own remote-access path instead of through the tunnel. To keep per-user watch history correct without ever putting a full-access credential in the browser, the server mints a short-lived transient token from each user's Plex token and hands only that to the client. This is specced and on the roadmap; the rest of the app is live.

**Joining two id systems.** Discovery is keyed by TMDB id, while Plex is keyed by its own rating keys. Availability and playability come from matching the two through Seerr's media records, so the app can show accurate status without guessing by title.

## Tech stack

- TypeScript across frontend and backend
- React and Vite
- Node and Express
- Docker and Cloudflare Tunnel for deployment
- Integrations: Plex, Seerr, TMDB, Radarr, Sonarr
- Around 100 server-side tests on Node's built-in test runner

## How it is built

The work is done in small, single-purpose increments. Each change is scoped to one concern, written against a short spec, reviewed against that spec, and smoke-tested against a real production build before it is committed. Longer-lived context lives in a handoff document and per-increment specs so any piece can be picked up cold later. The result is a history of small, reviewable commits instead of large drops, and features that were verified running rather than assumed working.

## Status and roadmap

Tyflix is deployed and in daily use on my home server, and it is still an active work in progress. It already covers most of Seerr's user-facing surface, plus features Seerr does not have, like the per-user watched-versus-requested analytics.

The next major piece is in-browser playback, which is fully designed and specced. Today Tyflix stops at request and track; playback turns it into a place you actually watch. The design connects the browser straight to Plex for the video, which keeps heavy streaming off the Cloudflare Tunnel for both cost and terms reasons. Each playback session is authorized with a short-lived, per-user token minted on the server, so the real Plex credential never reaches the browser. Progress is reported back to Plex so it records watch history and resume points. That last part closes a nice loop: watching through Tyflix finally feeds the same watched-versus-requested numbers the analytics already report.

Further out: a continue-watching rail, subtitle and audio-track selection, and adaptive quality. The guiding idea is to keep integrating tools that already exist rather than rebuilding them, so Tyflix stays a thin, sharp layer over Plex and Seerr instead of a second copy of either.

## Notes

Tyflix is a personal, self-hosted project. It is not affiliated with Plex, and it does not host or distribute media. It manages access to a private Plex library. This repository holds the application code; deployment details specific to my own network are kept out of it.
