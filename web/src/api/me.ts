export type MyStatsTotals = {
  requests: number;
  available: number;
  pending: number;
  gbRequestedBytes: number;
  gbWatchedBytes: number;
  gbUnwatchedBytes: number;
  rate: number | null;
};

export type UnwatchedTitle = {
  title: string;
  type: "movie" | "tv";
  unwatchedBytes: number;
  epsWatched: number;
  epsTotal: number;
  requestedAt: string;
};

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

export type QuotaAxis = {
  days: number;
  limit: number;
  used: number;
  restricted: boolean;
};

export type MyQuota = {
  movie: QuotaAxis;
  tv: QuotaAxis;
};

export type FormattedQuota = {
  text: string;
  restricted: boolean;
};

export async function fetchMyStats(): Promise<MyStats> {
  const res = await fetch("/api/me/stats");
  if (!res.ok) {
    throw new Error(`Failed to load stats (${res.status})`);
  }
  return (await res.json()) as MyStats;
}

export async function fetchMyQuota(): Promise<MyQuota> {
  const res = await fetch("/api/me/quota");
  if (!res.ok) {
    throw new Error(`Failed to load request quota (${res.status})`);
  }
  return (await res.json()) as MyQuota;
}

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

/** Formats byte counts as GB or TB with one decimal place. */
export function formatBytes(bytes: number): string {
  const tib = 1024 ** 4;
  const gib = 1024 ** 3;
  if (bytes >= tib) {
    return `${(bytes / tib).toFixed(1)} TB`;
  }
  return `${(bytes / gib).toFixed(1)} GB`;
}
