// Client for GET /api/me/badge-counts (server/src/routes/me.ts). AppShell is
// the only caller: it polls once a minute for every signed-in user and feeds
// the result into the desktop sidebar and MobileNav badges.
//
// Errors follow the api/ convention: throw on non-2xx. AppShell catches and
// leaves the last good counts alone rather than blanking the nav mid-session.

export type BadgeCounts = {
  mine: { requests: number; issues: number };
  admin: { requests: number; issues: number; access: number } | null;
};

/** Sum of the three admin badge fields, or 0 when admin is null. */
export function adminBadgeRollup(admin: BadgeCounts["admin"]): number {
  if (admin === null) {
    return 0;
  }
  return admin.requests + admin.issues + admin.access;
}

/**
 * GET /api/me/badge-counts. Every nav badge number in one response.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchBadgeCounts(): Promise<BadgeCounts> {
  const res = await fetch("/api/me/badge-counts");
  if (!res.ok) {
    throw new Error(`Failed to load badge counts (${res.status})`);
  }
  return (await res.json()) as BadgeCounts;
}
