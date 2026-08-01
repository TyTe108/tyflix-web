// Fresh Seerr permission lookup for an already-verified session, plus a
// revocation check against the durable session-revocation store.
//
// requireAuth / requireAdmin and GET /api/auth/me all go through here so the
// fetch-and-classify logic lives in one place. The cookie's permissions field
// is not consulted — only the Seerr record for session.seerrUserId.
//
// Revocation is checked first, on every call, never cached. The Phase 32
// coalescing cache sits below it; putting the check after the cache hit would
// let a logged-out cookie keep working for up to 10 seconds.

import type { SeerrClient } from "../seerr/client";
import type { SessionRevocationStore } from "../sessionRevocation";
import type { SessionPayload } from "../session";

/**
 * Burst-coalescing cache in front of getUserById.
 *
 * What it buys: LibraryPage renders PAGE_SIZE = 48 posters, and
 * /api/library/image sits behind requireAuth, so one Library view is ~49
 * authenticated requests. Without this, that burst would hit Seerr ~49 times.
 * Collapsing them to one call is the measured reason this exists.
 *
 * What it costs: up to 10 seconds of permission staleness (a revoke or grant
 * in Seerr may not be seen until the window elapses). Session revocation is
 * NOT covered by this cache — it is checked on every call before the lookup.
 *
 * Errors are deliberately not cached. A cached failure would 503 every request
 * for that user for the rest of the window even after Seerr has recovered; the
 * next request must always be allowed to retry.
 */
const PERMISSION_CACHE_TTL_MS = 10_000;

type CacheEntry = {
  permissions: number;
  expiresAt: number;
};

const cache = new Map<number, CacheEntry>();
const inflight = new Map<number, Promise<PermissionRevalidation>>();

/**
 * Outcomes of revalidating an already-verified session:
 *
 * - `ok`: Seerr confirmed the account; `permissions` is the live bitfield.
 *   Callers attach it to `res.locals.session` (request-scoped only; do not
 *   re-issue the cookie) and continue.
 * - `revoked`: the session's iat is strictly before this user's validAfter in
 *   the revocation store. Callers must reject with 401 — same body as a
 *   missing cookie. Never distinguish this from not_found in the response.
 * - `not_found`: Seerr answered 404 — the account no longer exists. Callers
 *   must reject with 401. Never fall through to the cookie's permissions.
 * - `unreachable`: transport failure, timeout, unexpected body, or any other
 *   Seerr error. Callers must reject with 503. Never fall through to the
 *   cookie's permissions, and never treat this as not_found.
 */
export type PermissionRevalidation =
  | { status: "ok"; permissions: number }
  | { status: "revoked" }
  | { status: "not_found" }
  | { status: "unreachable" };

export type RevalidatePermissionsOptions = {
  /** Injectable clock for tests. Production uses Date.now. */
  now?: () => number;
};

/**
 * Checks revocation, then looks up the session's Seerr user and classifies the
 * result. See PermissionRevalidation for what each status means and what
 * callers should do.
 *
 * Ordering is load-bearing: revocation runs before the coalescing cache. A
 * cache hit must never skip the revocation check.
 */
export async function revalidateSessionPermissions(
  session: SessionPayload,
  seerr: Pick<SeerrClient, "getUserById">,
  revocation: Pick<SessionRevocationStore, "isRevoked">,
  options: RevalidatePermissionsOptions = {},
): Promise<PermissionRevalidation> {
  // Always first, never cached: in-memory integer compare, and still correct
  // while Seerr is down.
  if (revocation.isRevoked(session.seerrUserId, session.iat)) {
    return { status: "revoked" };
  }

  const now = options.now ?? Date.now;
  const userId = session.seerrUserId;

  const cached = cache.get(userId);
  if (cached !== undefined && cached.expiresAt > now()) {
    return { status: "ok", permissions: cached.permissions };
  }

  const existing = inflight.get(userId);
  if (existing !== undefined) {
    return existing;
  }

  const pending = (async (): Promise<PermissionRevalidation> => {
    try {
      const user = await seerr.getUserById(userId);
      if (user === null) {
        return { status: "not_found" };
      }
      cache.set(userId, {
        permissions: user.permissions,
        expiresAt: now() + PERMISSION_CACHE_TTL_MS,
      });
      return { status: "ok", permissions: user.permissions };
    } catch {
      return { status: "unreachable" };
    } finally {
      inflight.delete(userId);
    }
  })();

  inflight.set(userId, pending);
  return pending;
}

/** Clears the coalescing cache. Test-only — production never calls this. */
export function clearPermissionCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
