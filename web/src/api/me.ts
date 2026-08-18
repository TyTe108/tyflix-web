// Client for the server's me router (server/src/routes/me.ts), mounted at
// /api/me behind requireAuth. Three shapes of call about the signed-in user:
// watched-versus-requested numbers, Seerr request quota, and preference writes.
//
// The stats are the one thing Tyflix computes that Seerr doesn't. The server
// joins Seerr's request list to Plex's watch history, then weights everything
// by file size, so "you've watched 40% of what you asked for" is measured in GB
// rather than in titles. Both the Plex account list and the history are cached
// for a minute server-side, since they're the same for everyone.
//
// Preferences are a local JSON-file store on the server — no Plex/Seerr call.
//
// Errors follow the api/discover.ts convention: throw on non-2xx.

import type { UserPreferences } from "./auth";

// The GB-weighted headline numbers. Despite the gb* names these are all raw
// byte counts; formatBytes at the bottom is what turns them into GB or TB.
export type MyStatsTotals = {
  requests: number;
  available: number;
  pending: number;
  gbRequestedBytes: number;
  gbWatchedBytes: number;
  gbUnwatchedBytes: number;
  rate: number | null; // watched share, 0-100; null when nothing measurable is on disk
};

// A title you asked for and haven't finished. For movies epsTotal is the whole
// film rather than an episode count, so read the pair as progress, not as a
// season length.
export type UnwatchedTitle = {
  title: string;
  type: "movie" | "tv";
  unwatchedBytes: number;
  epsWatched: number;
  epsTotal: number;
  requestedAt: string; // ISO
};

// `plexLinked` false means the server couldn't match this session to a Plex
// account, so the watch sets are empty and the page renders requests-only. It's
// still a 200. `watchedDefinition` is a sentence the server writes explaining
// what counts as watched, shown verbatim so the UI never implies its own
// methodology.
export type MyStats = {
  plexLinked: boolean;
  user: {
    seerrUserId: number;
    displayName: string;
  };
  totals: MyStatsTotals;
  unwatchedTitles: UnwatchedTitle[];
  watchedDefinition: string;
};

// One half of a Seerr quota, passed through untouched. A `limit` of 0 is
// Seerr's way of saying unlimited, not "you may request nothing".
export type QuotaAxis = {
  days: number; // rolling window length
  limit: number; // 0 means unlimited
  used: number;
  restricted: boolean; // Seerr's own verdict on whether they're capped out
};

// Movies and shows get separate quotas in Seerr.
export type MyQuota = {
  movie: QuotaAxis;
  tv: QuotaAxis;
};

export type FormattedQuota = {
  text: string;
  restricted: boolean;
};

/**
 * GET /api/me/stats. Watched-versus-requested for the signed-in user, which is
 * the whole Home page.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchMyStats(): Promise<MyStats> {
  const res = await fetch("/api/me/stats");
  if (!res.ok) {
    throw new Error(`Failed to load stats (${res.status})`);
  }
  return (await res.json()) as MyStats;
}

/**
 * GET /api/me/quota. Seerr's quota record for the signed-in user, which is what
 * lets the request dialog say "3 of 5 left this week".
 *
 * @throws Error on any non-2xx.
 */
export async function fetchMyQuota(): Promise<MyQuota> {
  const res = await fetch("/api/me/quota");
  if (!res.ok) {
    throw new Error(`Failed to load request quota (${res.status})`);
  }
  return (await res.json()) as MyQuota;
}

/**
 * PATCH /api/me/preferences. Merges a partial preferences object for the
 * signed-in user and returns the full merged result from the server.
 *
 * @throws Error on any non-2xx — never resolves with a locally assumed value.
 */
export async function updatePreferences(
  patch: Partial<UserPreferences>,
): Promise<UserPreferences> {
  const res = await fetch("/api/me/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`Failed to update preferences (${res.status})`);
  }
  return (await res.json()) as UserPreferences;
}

/**
 * Turns one quota axis into the line shown under the Request button.
 *
 * `restricted` here is a little broader than Seerr's own flag: it also goes
 * true when the remaining count hits zero, so the button disables on the last
 * request rather than on the next failed one.
 */
export function formatQuota(axis: QuotaAxis): FormattedQuota {
  if (axis.limit === 0) {
    return { text: "Unlimited", restricted: false };
  }

  const remaining = Math.max(0, axis.limit - axis.used);
  return {
    text: `${remaining} of ${axis.limit} left · resets every ${axis.days} days`,
    restricted: axis.restricted || remaining === 0,
  };
}

/**
 * Formats byte counts as GB or TB with one decimal place.
 *
 * Binary units under the hood (1024-based), labelled with the decimal names,
 * which is the same fudge every file manager makes.
 */
export function formatBytes(bytes: number): string {
  const tib = 1024 ** 4;
  const gib = 1024 ** 3;
  if (bytes >= tib) {
    return `${(bytes / tib).toFixed(1)} TB`;
  }
  return `${(bytes / gib).toFixed(1)} GB`;
}
