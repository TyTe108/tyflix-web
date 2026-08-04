// The two rate limiters, both mounted in index.ts. apiRateLimiter covers the
// whole /api surface. accessRequestLimiter stacks on top of it for the one
// public write endpoint, /api/access-requests.
//
// Everything here is in-process memory, which is fine for a single container
// and would need a shared store the moment there's a second one. Counters reset
// on deploy, and that's acceptable.
//
// The interesting part is the key. Sitting behind a Cloudflare Tunnel means
// every request arrives from the tunnel, so keying on the socket address would
// lump the entire internet into one bucket. See clientIpKey below.

import type { Request } from "express";
import { rateLimit } from "express-rate-limit";

// General limiter for the whole /api surface. Deliberately generous so a normal
// login + browse session is never throttled; tighter auth-specific limits are a
// separate increment.
const GENERAL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const GENERAL_MAX_REQUESTS = 1000; // was 200 — 200 self-429s the admin dashboard's 5s pollers within a window

// The origin is only reachable through the Cloudflare Tunnel, which sets and
// overwrites CF-Connecting-IP with the real client IP. The TCP peer is always
// the tunnel, so req.ip is the container address and useless for keying. We
// intentionally do NOT enable Express "trust proxy" (which would let a client
// spoof X-Forwarded-For); instead we key directly on the tunnel-provided header
// and only fall back to req.ip for local dev where the header is absent.
//
// The Array.isArray branch is for a duplicated header, where Node hands back a
// string[] and the first entry wins. If both the header and req.ip come back
// empty, everything shares the "unknown" bucket, which throttles harder rather
// than not at all.
function clientIpKey(req: Request): string {
  const header = req.headers["cf-connecting-ip"];
  const cfConnectingIp = Array.isArray(header) ? header[0] : header;
  return cfConnectingIp?.trim() || req.ip || "unknown";
}

/**
 * Blanket limiter for /api. Mounted before every router in index.ts, so it's
 * the first thing an unauthenticated flood hits.
 *
 * standardHeaders puts the remaining budget in RateLimit-* response headers;
 * legacyHeaders drops the older X-RateLimit-* pair. The 429 body is JSON so a
 * throttled fetch() parses the same way a normal error does.
 */
export const apiRateLimiter = rateLimit({
  windowMs: GENERAL_WINDOW_MS,
  limit: GENERAL_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { error: "Too many requests, please try again later." },
});

// Public access-request submit: 5/hour/IP. Much tighter than the general
// limiter — each submission costs owner attention.
const ACCESS_REQUEST_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ACCESS_REQUEST_MAX = 5;

/**
 * Limiter for the public access-request form, stacked on top of apiRateLimiter
 * at that mount so both budgets apply.
 *
 * This is the only unauthenticated write endpoint in the app (the /api/auth
 * routes, /api/config and /healthz are anonymous too, but none of them create
 * anything), which makes it the one worth abusing. Paired with a honeypot field
 * in the router, it takes the place of a CAPTCHA.
 */
export const accessRequestLimiter = rateLimit({
  windowMs: ACCESS_REQUEST_WINDOW_MS,
  limit: ACCESS_REQUEST_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { error: "Too many requests, please try again later." },
});

// Covers the production-only static/SPA surface mounted in index.ts: the built
// web assets plus the "/{*path}" splat that hands every unmatched path
// index.html. That block sits outside /api, so apiRateLimiter never sees it --
// CodeQL correctly flagged it as an unbounded filesystem read (alert #4,
// js/missing-rate-limiting). Own bucket rather than reusing apiRateLimiter: a
// single page load can fan out into a couple dozen JS/CSS/font requests, a
// different shape than an API call, and sharing one bucket would make the
// /api budget's existing tuning (see GENERAL_MAX_REQUESTS above) harder to
// reason about.
const STATIC_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const STATIC_MAX_REQUESTS = 1000; // same ceiling as apiRateLimiter to start -- this is DoS protection, not a throttle on real use

/**
 * Limiter for the production static/SPA-fallback block in index.ts. Mounted
 * ahead of both express.static and the splat route, so it covers every
 * filesystem read that block can trigger.
 */
export const staticRateLimiter = rateLimit({
  windowMs: STATIC_WINDOW_MS,
  limit: STATIC_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { error: "Too many requests, please try again later." },
});
