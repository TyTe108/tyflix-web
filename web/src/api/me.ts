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

export async function fetchMyStats(): Promise<MyStats> {
  const res = await fetch("/api/me/stats");
  if (!res.ok) {
    throw new Error(`Failed to load stats (${res.status})`);
  }
  return (await res.json()) as MyStats;
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
