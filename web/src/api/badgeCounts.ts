// Client for GET /api/me/badge-counts (server/src/routes/me.ts). AppShell polls
// it for the primary-nav badges; AdminPage polls it for the Requests / Issues /
// Access tab dots. Both use the same 60s interval.
//
// Errors follow the api/ convention: throw on non-2xx. Callers catch and leave
// the last good counts alone rather than blanking badges mid-session.

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
