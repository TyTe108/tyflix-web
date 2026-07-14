export type WatchedSets = {
  movies: Set<string>;
  episodes: Set<string>;
};

export type AnalyticsEpisode = {
  rk: string;
  sizeBytes: number;
  season: number;
};

export type AnalyticsItem = {
  title: string;
  sizeBytes: number;
  episodes: AnalyticsEpisode[] | null;
};

export type AnalyticsRequest = {
  type: "movie" | "tv";
  media: {
    status: number;
    ratingKey: string | number | null;
    mediaType: string | null;
  };
  seasons: Array<{ seasonNumber: number | null }>;
  createdAt: string;
};

export type UnwatchedTitle = {
  title: string;
  type: "movie" | "tv";
  unwatchedBytes: number;
  epsWatched: number;
  epsTotal: number;
  requestedAt: string;
};

export type WatchedVsRequestedResult = {
  totals: {
    requests: number;
    available: number;
    pending: number;
    gbRequestedBytes: number;
    gbWatchedBytes: number;
    gbUnwatchedBytes: number;
    rate: number | null;
  };
  unwatchedTitles: UnwatchedTitle[];
};

export async function computeWatchedVsRequested(
  requests: AnalyticsRequest[],
  watched: WatchedSets,
  getItem: (
    ratingKey: string,
    isShow: boolean,
  ) => AnalyticsItem | Promise<AnalyticsItem>,
): Promise<WatchedVsRequestedResult> {
  let available = 0;
  let pending = 0;
  let gbRequestedBytes = 0;
  let gbWatchedBytes = 0;
  let gbUnwatchedBytes = 0;
  const unwatchedTitles: UnwatchedTitle[] = [];

  for (const request of requests) {
    const ratingKey = request.media.ratingKey;
    const onDisk =
      (request.media.status === 4 || request.media.status === 5) &&
      ratingKey !== null &&
      ratingKey !== undefined &&
      String(ratingKey) !== "";

    if (!onDisk) {
      pending += 1;
      continue;
    }

    available += 1;
    const isShow =
      request.type === "tv" || request.media.mediaType === "tv";
    const rk = String(ratingKey);
    const item = await getItem(rk, isShow);

    let total: number;
    let watchedBytes: number;
    let epsTotal: number;
    let epsWatched: number;
    const titleType: "movie" | "tv" = isShow ? "tv" : "movie";

    if (!isShow) {
      total = item.sizeBytes;
      watchedBytes = watched.movies.has(rk) ? total : 0;
      epsTotal = 1;
      epsWatched = watchedBytes > 0 ? 1 : 0;
    } else {
      const episodes = item.episodes ?? [];
      const requestedSeasons = new Set<number>();
      for (const season of request.seasons) {
        if (typeof season.seasonNumber === "number") {
          requestedSeasons.add(season.seasonNumber);
        }
      }

      let sel = episodes.filter((ep) => requestedSeasons.has(ep.season));
      if (requestedSeasons.size === 0 || sel.length === 0) {
        sel = episodes;
      }

      total = 0;
      watchedBytes = 0;
      epsWatched = 0;
      for (const ep of sel) {
        total += ep.sizeBytes;
        if (watched.episodes.has(ep.rk)) {
          watchedBytes += ep.sizeBytes;
          epsWatched += 1;
        }
      }
      epsTotal = sel.length;
    }

    const unwatched = total - watchedBytes;
    gbRequestedBytes += total;
    gbWatchedBytes += watchedBytes;
    gbUnwatchedBytes += unwatched;

    if (unwatched > 0) {
      unwatchedTitles.push({
        title: item.title,
        type: titleType,
        unwatchedBytes: unwatched,
        epsWatched,
        epsTotal,
        requestedAt: request.createdAt.slice(0, 10),
      });
    }
  }

  const rate =
    gbRequestedBytes > 0
      ? Math.round((100 * gbWatchedBytes) / gbRequestedBytes)
      : null;

  unwatchedTitles.sort((a, b) => b.unwatchedBytes - a.unwatchedBytes);

  return {
    totals: {
      requests: requests.length,
      available,
      pending,
      gbRequestedBytes,
      gbWatchedBytes,
      gbUnwatchedBytes,
      rate,
    },
    unwatchedTitles,
  };
}
