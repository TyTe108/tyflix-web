// The "you requested X, you watched Y" numbers on Home and in the admin
// per-user panel.
//
// It joins two things the rest of the app already has: what a user asked Seerr
// for, and what Plex says they've played. The unit is bytes on disk, not
// titles, because a movie someone skipped and a nine-season show someone
// skipped are not the same amount of wasted storage.
//
// Pure function on purpose. Both upstreams (Seerr requests and Plex history)
// are fetched by routes/me.ts and handed in, and the per-title size lookup
// arrives as a callback. That's what makes this testable without touching a
// network, and the test file is the readable spec for the edge cases.

// Plex ratingKeys the user has actually watched, split by kind. Movies are
// matched on the movie's own key; shows are matched per episode.
export type WatchedSets = {
  movies: Set<string>;
  episodes: Set<string>;
};

export type AnalyticsEpisode = {
  rk: string; // Plex ratingKey for this episode
  sizeBytes: number;
  season: number;
};

// One title's size on disk. Mirrors PlexItem from plex/server.ts, kept separate
// so this module doesn't depend on the Plex client.
export type AnalyticsItem = {
  title: string;
  sizeBytes: number; // whole-title size; only read for movies
  episodes: AnalyticsEpisode[] | null; // null for movies
};

// The slice of a Seerr request this calculation needs. Structurally compatible
// with SeerrRequest, so routes/me.ts passes those straight through.
export type AnalyticsRequest = {
  type: "movie" | "tv";
  media: {
    status: number; // Seerr MEDIA_STATUS; 4 and 5 are the on-disk ones
    ratingKey: string | number | null;
    mediaType: string | null;
  };
  seasons: Array<{ seasonNumber: number | null }>; // empty for movies
  createdAt: string;
};

// A row in the "sitting there untouched" table.
export type UnwatchedTitle = {
  title: string;
  type: "movie" | "tv";
  unwatchedBytes: number;
  epsWatched: number; // 0 or 1 for a movie
  epsTotal: number; // always 1 for a movie
  requestedAt: string; // YYYY-MM-DD, date only
};

export type WatchedVsRequestedResult = {
  totals: {
    requests: number; // everything requested, on disk or not
    available: number; // on disk and measurable
    pending: number; // requested but not on disk yet, so it counts zero bytes
    gbRequestedBytes: number; // bytes, despite the name; the UI does the GB conversion
    gbWatchedBytes: number;
    gbUnwatchedBytes: number;
    rate: number | null; // watched percentage, rounded; null when nothing is on disk
  };
  unwatchedTitles: UnwatchedTitle[]; // biggest waste first
};

/**
 * Works out how much of what someone requested they actually watched, weighted
 * by bytes on disk.
 *
 * Requests that haven't landed yet are counted but contribute no bytes, so
 * asking for something the server is still downloading can't drag your rate
 * down. For shows, only the seasons that were actually requested are measured,
 * which stops a request for season 1 from being judged against all nine.
 *
 * @param getItem resolves a Plex ratingKey to its size. Called once per
 * available request, and only for those, so a pending queue costs nothing.
 * @throws whatever getItem throws. There's no per-title catch here, so one
 * failed Plex lookup fails the whole calculation.
 */
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
    // On disk means two things at once: Seerr says it's available or partially
    // available (status 4 or 5), and there's a real Plex ratingKey to measure
    // against. Either half missing and there's nothing to weigh, so the request
    // counts toward the total but contributes no bytes.
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
    // Trust either signal. Seerr's request type and its media record can
    // disagree, and treating a show as a movie would measure one file instead
    // of every episode.
    const isShow =
      request.type === "tv" || request.media.mediaType === "tv";
    const rk = String(ratingKey);
    const item = await getItem(rk, isShow);

    let total: number;
    let watchedBytes: number;
    let epsTotal: number;
    let epsWatched: number;
    const titleType: "movie" | "tv" = isShow ? "tv" : "movie";

    // A movie is all or nothing: watched means the whole file counts.
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

      // Narrow to the seasons this request actually asked for. Two fallbacks to
      // the full show: a request that named no seasons, and a request whose
      // seasons match nothing on disk. Without the second one, a season
      // numbering mismatch would silently report zero bytes requested.
      let sel = episodes.filter((ep) => requestedSeasons.has(ep.season));
      if (requestedSeasons.size === 0 || sel.length === 0) {
        sel = episodes;
      }

      // Per-episode from here. Both the byte totals and the "3 of 9 watched"
      // counter come out of this one pass.
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

    // Only titles with something left unwatched make the list. A fully watched
    // show isn't waste and doesn't belong in the table.
    if (unwatched > 0) {
      unwatchedTitles.push({
        title: item.title,
        type: titleType,
        unwatchedBytes: unwatched,
        epsWatched,
        epsTotal,
        // ISO timestamp trimmed to the date. The UI only ever shows the day.
        requestedAt: request.createdAt.slice(0, 10),
      });
    }
  }

  // Null rather than 0 when nothing is on disk yet. Zero percent reads like a
  // judgement; null lets the UI say there's nothing to measure.
  const rate =
    gbRequestedBytes > 0
      ? Math.round((100 * gbWatchedBytes) / gbRequestedBytes)
      : null;

  // Biggest waste first, which is the order both the Home list and the admin
  // panel display in.
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
