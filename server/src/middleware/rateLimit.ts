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
function clientIpKey(req: Request): string {
  const header = req.headers["cf-connecting-ip"];
  const cfConnectingIp = Array.isArray(header) ? header[0] : header;
  return cfConnectingIp?.trim() || req.ip || "unknown";
}

export const apiRateLimiter = rateLimit({
  windowMs: GENERAL_WINDOW_MS,
  limit: GENERAL_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { error: "Too many requests, please try again later." },
});
