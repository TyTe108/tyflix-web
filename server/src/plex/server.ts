// Client for our own Plex Media Server's HTTP API: library sections and items,
// metadata, episode trees, artwork, watch state, and timeline reporting.
//
// index.ts builds one of these from config.plexBaseUrl plus the OWNER token and
// injects it into the library, watch, and me routers. Everything here hits the
// PMS on the LAN. plex.tv account calls live in client.ts, and the plex.direct
// addresses the browser actually streams video from come from connection.ts.
//
// Two things trip people up. First, the JSON is Plex's XML wearing a hat:
// capitalized element names as keys (MediaContainer, Metadata, Directory, Media,
// Part, Stream, Guid, Marker), ids that arrive as either numbers or strings
// depending on the endpoint, and booleans that arrive as 0/1. So every list goes
// through asArray, every id gets String()'d on the way out, and every flag goes
// through plexBool. Second, the owner token is the wrong token for a shared
// user. Anything whose answer depends on who's asking takes an explicit
// userToken. The per-user reads (playbackMeta, sectionItems, onDeck) go out
// through getJsonWithToken instead of getJson; the two per-user writes
// (selectSubtitle, reportTimeline) build their own request and carry the same
// token themselves. Getting that wrong is what broke every shared account once.

/**
 * Thrown for every failure talking to the PMS, with the upstream HTTP status
 * attached so route handlers can map it back to a client response.
 *
 * Network-level failures (DNS, refused, timeout) are normalized to 502, since
 * there's no upstream status to report.
 */
export class PlexServerUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PlexServerUpstreamError";
    this.status = status;
  }
}

export type PlexServerClientOptions = {
  // LAN URL of our PMS, e.g. http://10.0.0.10:32400 (config.plexBaseUrl).
  baseUrl: string;
  // Owner/server token (config.plexToken). Used for everything that isn't
  // per-user; per-user calls take a separate token argument.
  token: string;
};

// Everything one Plex account has watched, as ratingKeys. Movies and episodes
// stay in separate sets because a show's watch state is only ever computed from
// its episode leaves, never from the show's own key.
export type PlexWatchedSets = {
  movies: Set<string>;
  episodes: Set<string>;
};

// One episode of a show, flattened for the GB-weighted analytics in
// analytics/watchedVsRequested.ts. `rk` is the episode's own ratingKey and
// `season` is Plex's parentIndex.
export type PlexEpisodeLeaf = {
  rk: string;
  sizeBytes: number;
  season: number;
};

// A requested title reduced to what the analytics needs. `episodes` is null for
// movies, which is also how callers tell the two apart. For a show, sizeBytes is
// the sum across every episode leaf.
export type PlexItem = {
  title: string;
  sizeBytes: number;
  episodes: PlexEpisodeLeaf[] | null;
};

// One episode row for the player's episode list and for Up Next.
export type PlexEpisode = {
  ratingKey: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  // Plex-relative image path like /library/metadata/201/thumb/1781154351, not a
  // full URL. That's exactly the shape GET /api/library/image accepts.
  thumb: string | null;
};

// One audio track on the part being played. `id` is Plex's stream id, which is
// what goes back as audioStreamID on a transcode URL.
export type AudioStream = {
  id: string;
  language: string | null;
  codec: string | null;
  channels: number | null;
  title: string | null;
  default: boolean;
};

// One subtitle track on the part being played. `id` is the stream id used both
// for the part-level selection PUT and for subtitleStreamID on a transcode URL.
export type SubtitleStream = {
  id: string;
  language: string | null;
  codec: string | null;
  title: string | null;
  forced: boolean;
  // True when the stream carries a `key`, which is how this code decides a
  // subtitle is a separate sidecar rather than muxed into the media.
  external: boolean;
  // Whether the codec is one we consider convertible to text. See
  // isTextBasedSubtitleCodec; it's a fixed allow-list, not something Plex tells us.
  textBased: boolean;
};

// Everything the watch router needs to start a stream and draw the player
// chrome around it. Produced by playbackMeta().
export type PlaybackMeta = {
  durationMs: number | null;
  // Start of the credits, in ms from the top. Drives the Up Next card. Null
  // whenever the item has no usable credits marker.
  creditsOffsetMs: number | null;
  // Media part id. Needed before subtitles can be selected, since selection is a
  // PUT against the part and not against the item.
  partId: string | null;
  audio: AudioStream[];
  subtitle: SubtitleStream[];
  // Display strings, already resolved for movie vs episode. For an episode the
  // title is the show and the subheading carries "S1E1 · Pilot".
  title: string | null;
  subheading: string | null;
  // Resume position in ms. Only meaningful when playbackMeta was called with a
  // user token, because the owner token returns the owner's progress.
  viewOffsetMs: number | null;
};

// One browsable library on the server. `key` is the section id that goes into
// every /library/sections/<key>/... path. Music and photo sections get filtered
// out in sections() below, so type is only ever movie or show here.
export type LibrarySection = {
  key: string;
  title: string;
  type: "movie" | "show";
};

// A single row of a section listing, normalized for the Library grid.
export type LibraryItem = {
  ratingKey: string;
  // Plex's own type string ("movie", "show", ...), passed through as-is.
  type: string;
  title: string;
  year: number | null;
  // Plex-relative image path, same shape as PlexEpisode.thumb.
  thumb: string | null;
  // Unix seconds, not ms. Plex reports addedAt in seconds while every duration
  // on this type is in ms.
  addedAt: number | null;
  // Dug out of the Guid rows. This is the hinge between the Plex side of the app
  // and the TMDB side, and it's null for anything Plex matched some other way,
  // which is why the Library can also play straight off a ratingKey.
  tmdbId: number | null;
  summary: string | null;
  // audienceRating when present, otherwise the critic rating.
  rating: number | null;
  contentRating: string | null;
  runtime: number | null; // whole minutes, rounded from durationMs
  durationMs: number | null;
  genres: string[];
  // Per-account watch state. These three reflect whoever's token made the call,
  // so the library router blanks them out when it had no user token to send.
  viewOffset: number | null; // ms into the item
  viewCount: number | null;
  lastViewedAt: number | null; // unix seconds
};

// Sort options the API exposes. Deliberately a small closed set, since the value
// gets handed to Plex.
export type LibrarySortKey = "title" | "added" | "year" | "rating";

// One Continue Watching card. Plex's On Deck mixes movies and episodes in a
// single list, so the two get flattened into the same shape here.
export type OnDeckItem = {
  ratingKey: string;
  type: "movie" | "episode";
  // For an episode this is the show's title, not the episode's.
  title: string;
  // Year for a movie, "S1E1" for an episode.
  subtitle: string | null;
  thumb: string | null;
  viewOffset: number | null; // ms into the item
  duration: number | null; // ms
};

// Our sort keys to Plex's "<field>:<direction>" sort syntax. Note that the title
// option maps to titleSort, Plex's separate sort field, and not to title.
const LIBRARY_SORT_TO_PLEX: Record<LibrarySortKey, string> = {
  title: "titleSort:asc",
  added: "addedAt:desc",
  year: "year:desc",
  rating: "rating:desc",
};

/**
 * Translates an app sort key into the value Plex's `sort` query param wants.
 *
 * Exported mostly so route tests can assert the mapping without going through a
 * live client.
 */
export function mapLibrarySort(sort: LibrarySortKey): string {
  return LIBRARY_SORT_TO_PLEX[sort];
}

/**
 * Builds the PMS client. One instance is created at startup in index.ts and
 * shared by every router, so anything closed over here (the item cache below)
 * lives for the life of the process.
 *
 * Every method throws PlexServerUpstreamError on failure. The one exception is
 * fetchImage, which reports a non-OK upstream in its return value.
 */
export function createPlexServerClient(options: PlexServerClientOptions) {
  const { baseUrl, token } = options;
  // Memoizes item() so the analytics rollup doesn't refetch a title it's already
  // sized. Never expires and never evicts, so a title that grows on disk keeps
  // reporting its old size until the process restarts.
  const itemCache = new Map<string, PlexItem>();

  // GET a JSON document as the server owner. The Accept header negotiates JSON
  // rather than Plex's XML. Only the fetch itself is wrapped, so a 200 carrying
  // something unparseable escapes as a raw parse error, not a
  // PlexServerUpstreamError. Every caller below layers its own shape checks on
  // top of the unknown that comes back.
  async function getJson(path: string, query?: Record<string, string>): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "X-Plex-Token": token,
          Accept: "application/json",
        },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Plex server request failed";
      throw new PlexServerUpstreamError(message, 502);
    }

    if (!res.ok) {
      throw new PlexServerUpstreamError(
        `Plex server ${path} failed (${res.status})`,
        res.status,
      );
    }

    return res.json();
  }

  // Same request as getJson, but as some other account. Used wherever the answer
  // is per-user (progress, On Deck), because the owner token would quietly
  // return the owner's answer instead of erroring, which is the worst kind of
  // bug to chase.
  async function getJsonWithToken(
    path: string,
    authToken: string,
    query?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "X-Plex-Token": authToken,
          Accept: "application/json",
        },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Plex server request failed";
      throw new PlexServerUpstreamError(message, 502);
    }

    if (!res.ok) {
      throw new PlexServerUpstreamError(
        `Plex server ${path} failed (${res.status})`,
        res.status,
      );
    }

    return res.json();
  }

  /**
   * Every account the PMS knows about, as accountID to display name.
   *
   * The numeric accountID is the join key for watch history. routes/me.ts
   * matches it against the session's plexId first and falls back to a
   * case-insensitive username match when the ids don't line up.
   */
  async function accounts(): Promise<Map<number, string>> {
    const body = await getJson("/accounts");
    const container = mediaContainer(body);
    const rows = asArray(container?.Account);
    const map = new Map<number, string>();

    for (const row of rows) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const id = (row as { id?: unknown }).id;
      const name = (row as { name?: unknown }).name;
      if (typeof id === "number" && typeof name === "string") {
        map.set(id, name);
      }
    }

    return map;
  }

  /**
   * The whole server's watch history, bucketed by accountID.
   *
   * Presence of a ratingKey in one of these sets is what the app means by
   * "watched" (routes/me.ts spells that definition out in its response). No
   * per-user filter goes out on the request. The owner token pulls the whole
   * server's history in one sweep and the caller picks out the account it wants,
   * so one fetch can answer for any number of users.
   *
   * Pages to the end before returning, so on a long history this is several
   * sequential round trips. Its only caller, routes/me.ts, caches the result for
   * a minute.
   */
  async function history(): Promise<Map<number, PlexWatchedSets>> {
    const pageSize = 500;
    let start = 0;
    let totalSize = Number.POSITIVE_INFINITY;
    const map = new Map<number, PlexWatchedSets>();

    while (start < totalSize) {
      // Despite the X- prefix making them look like headers, Plex takes the
      // container window as query params. The endpoint also lives under
      // /status/sessions even though it returns durable history rather than
      // what's playing right now.
      const body = await getJson("/status/sessions/history/all", {
        "X-Plex-Container-Start": String(start),
        "X-Plex-Container-Size": String(pageSize),
        sort: "viewedAt:desc",
      });

      // totalSize comes back on the container and is what ends the loop. If the
      // very first page doesn't carry one, treat the history as empty rather
      // than paging forever against an infinite bound.
      const container = mediaContainer(body);
      if (typeof container?.totalSize === "number") {
        totalSize = container.totalSize;
      } else if (start === 0) {
        totalSize = 0;
      }

      const metadata = asArray(container?.Metadata);
      for (const row of metadata) {
        if (typeof row !== "object" || row === null) {
          continue;
        }
        const accountID = (row as { accountID?: unknown }).accountID;
        const type = (row as { type?: unknown }).type;
        const ratingKey = (row as { ratingKey?: unknown }).ratingKey;
        if (typeof accountID !== "number") {
          continue;
        }
        if (typeof type !== "string") {
          continue;
        }
        if (ratingKey === undefined || ratingKey === null) {
          continue;
        }

        let sets = map.get(accountID);
        if (!sets) {
          sets = { movies: new Set(), episodes: new Set() };
          map.set(accountID, sets);
        }

        // Only movies and episodes are counted. Any other type falls through
        // and is dropped, since a show's watch state gets rolled up from its
        // episode leaves rather than read off the show itself.
        const key = String(ratingKey);
        if (type === "movie") {
          sets.movies.add(key);
        } else if (type === "episode") {
          sets.episodes.add(key);
        }
      }

      // Second exit, independent of totalSize: if a page comes back with no rows
      // there's nothing left to walk, whatever the container claimed.
      if (metadata.length === 0) {
        break;
      }
      start += pageSize;
    }

    return map;
  }

  /**
   * Size and title for one requested title, for the watched-versus-requested
   * analytics.
   *
   * Whether a ratingKey is a movie or a show isn't looked up here. The caller
   * already knows: analytics/watchedVsRequested.ts derives `isShow` from the
   * Seerr request and passes it down. Results are cached for the life of the
   * process.
   *
   * @param isShow selects between the movie fetch and the show fetch, which are
   * different enough (one request versus two) that they're separate functions.
   * @throws PlexServerUpstreamError when Plex has no metadata for the key.
   */
  async function item(ratingKey: string, isShow: boolean): Promise<PlexItem> {
    // isShow is part of the cache key, so the same ratingKey fetched both ways
    // gets two entries rather than one poisoning the other.
    const cacheKey = `${ratingKey}:${isShow ? "1" : "0"}`;
    const cached = itemCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = isShow
      ? await fetchShow(ratingKey)
      : await fetchMovie(ratingKey);
    itemCache.set(cacheKey, result);
    return result;
  }

  // One movie's title and on-disk size. sumMediaPartSizes walks every Media and
  // every Part, so a title with more than one version on the server reports the
  // total of all of them, not the size of the copy that would play.
  async function fetchMovie(ratingKey: string): Promise<PlexItem> {
    const body = await getJson(`/library/metadata/${ratingKey}`);
    const meta = firstMetadata(body);
    if (!meta) {
      throw new PlexServerUpstreamError(
        `Plex movie metadata missing for ${ratingKey}`,
        502,
      );
    }
    const title = typeof meta.title === "string" ? meta.title : "";
    const sizeBytes = sumMediaPartSizes(meta.Media);
    return { title, sizeBytes, episodes: null };
  }

  // A show's title plus every episode, flattened. Two round trips, because the
  // show document carries the title and allLeaves carries the episodes.
  //
  // Unlike fetchMovie, a missing show document isn't fatal here: the title falls
  // back to "" and the leaves still get fetched.
  async function fetchShow(ratingKey: string): Promise<PlexItem> {
    const showBody = await getJson(`/library/metadata/${ratingKey}`);
    const showMeta = firstMetadata(showBody);
    const title =
      showMeta && typeof showMeta.title === "string" ? showMeta.title : "";

    // allLeaves returns every episode of every season in one response, so
    // there's no need to walk seasons. Rows missing a ratingKey or a numeric
    // parentIndex get skipped; their bytes just don't count toward the total.
    const leavesBody = await getJson(
      `/library/metadata/${ratingKey}/allLeaves`,
    );
    const leaves = asArray(mediaContainer(leavesBody)?.Metadata);
    const episodes: PlexEpisodeLeaf[] = [];
    let sizeBytes = 0;

    for (const row of leaves) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const rk = (row as { ratingKey?: unknown }).ratingKey;
      const season = (row as { parentIndex?: unknown }).parentIndex;
      if (rk === undefined || rk === null || typeof season !== "number") {
        continue;
      }
      const epSize = sumMediaPartSizes((row as { Media?: unknown }).Media);
      episodes.push({ rk: String(rk), sizeBytes: epSize, season });
      sizeBytes += epSize;
    }

    return { title, sizeBytes, episodes };
  }

  /**
   * Every episode of a show, in season then episode order.
   *
   * Season and episode numbers live in Plex's `parentIndex` and `index`, which
   * is the naming most people have to look up once. A leaf missing either one
   * gets dropped rather than guessed at, so it won't show up in the episode
   * picker.
   *
   * @throws PlexServerUpstreamError when the allLeaves request fails.
   */
  async function episodes(showRatingKey: string): Promise<PlexEpisode[]> {
    const leavesBody = await getJson(
      `/library/metadata/${showRatingKey}/allLeaves`,
    );
    const leaves = asArray(mediaContainer(leavesBody)?.Metadata);
    const result: PlexEpisode[] = [];

    for (const row of leaves) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const rk = (row as { ratingKey?: unknown }).ratingKey;
      const season = (row as { parentIndex?: unknown }).parentIndex;
      const episode = (row as { index?: unknown }).index;
      const title = (row as { title?: unknown }).title;
      const thumb = (row as { thumb?: unknown }).thumb;
      if (
        rk === undefined ||
        rk === null ||
        typeof season !== "number" ||
        typeof episode !== "number"
      ) {
        continue;
      }
      result.push({
        ratingKey: String(rk),
        seasonNumber: season,
        episodeNumber: episode,
        title: typeof title === "string" ? title : "",
        thumb: typeof thumb === "string" ? thumb : null,
      });
    }

    // Response order isn't trusted, so sort here. Up Next depends on this being
    // right, since "next" is literally the following element.
    result.sort(
      (a, b) =>
        a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber,
    );
    return result;
  }

  /**
   * The episode that follows this one, or null when there isn't one.
   *
   * Because it walks the show's full flattened leaf list, rolling from a season
   * finale into the next season's premiere falls out for free. Null means either
   * the end of the show or an episode Plex doesn't file under a show.
   *
   * Two round trips per call, and nothing here is cached.
   *
   * @throws PlexServerUpstreamError when the episode has no metadata document.
   */
  async function nextEpisode(
    episodeRatingKey: string,
  ): Promise<PlexEpisode | null> {
    const body = await getJson(`/library/metadata/${episodeRatingKey}`);
    const meta = firstMetadata(body);
    if (!meta) {
      throw new PlexServerUpstreamError(
        `Plex episode metadata missing for ${episodeRatingKey}`,
        502,
      );
    }

    // Plex's hierarchy is show > season > episode, so from an episode the show
    // is the grandparent. It can arrive as a number or a string, hence the
    // String() below. No grandparent means there's no list to walk.
    const grandparent = meta.grandparentRatingKey;
    if (
      grandparent === undefined ||
      grandparent === null ||
      (typeof grandparent !== "string" && typeof grandparent !== "number")
    ) {
      return null;
    }

    // Find this episode in its show's ordered list and take the one after it.
    // The guard covers both ends: not found at all, or already the last leaf.
    const list = await episodes(String(grandparent));
    const idx = list.findIndex((ep) => ep.ratingKey === episodeRatingKey);
    if (idx < 0 || idx >= list.length - 1) {
      return null;
    }
    return list[idx + 1] ?? null;
  }

  /**
   * Everything the player needs about one item before it can start: duration,
   * resume point, credits marker, part id, and the audio and subtitle tracks.
   *
   * Pass `userToken` whenever the answer is for a person. viewOffset is stored
   * per account, so calling this with the owner token hands a shared user the
   * owner's resume position. The watch router passes the user's per-server token
   * when it builds a play descriptor and skips it when it only needs the part id.
   *
   * Works for movies and episodes alike; both are just metadata documents keyed
   * by ratingKey.
   *
   * @throws PlexServerUpstreamError on an upstream failure, and also on a
   * successful response whose container carries no Metadata row.
   */
  async function playbackMeta(
    ratingKey: string,
    userToken?: string,
  ): Promise<PlaybackMeta> {
    const path = `/library/metadata/${ratingKey}`;
    // Markers are opt-in. Without includeMarkers there's no Marker array, and
    // with no Marker array there's no credits offset, and with no credits offset
    // Up Next has nothing to fire on.
    const query = { includeMarkers: "1" };
    const body =
      userToken !== undefined
        ? await getJsonWithToken(path, userToken, query)
        : await getJson(path, query);
    const meta = firstMetadata(body);
    if (!meta) {
      throw new PlexServerUpstreamError(
        `Plex playback metadata missing for ${ratingKey}`,
        502,
      );
    }

    // Both offsets are milliseconds. A missing viewOffset reads as null rather
    // than 0, so callers can tell "no progress recorded" from "at the start".
    const durationMs =
      typeof meta.duration === "number" ? meta.duration : null;
    const viewOffsetMs =
      typeof meta.viewOffset === "number" ? meta.viewOffset : null;
    const creditsOffsetMs = creditsOffsetFromMarkers(meta.Marker);
    const audio: AudioStream[] = [];
    const subtitle: SubtitleStream[] = [];

    // Transcode URLs pin mediaIndex=0/partIndex=0, so only expose streams from
    // the first Media's first Part — later versions would map to the wrong ids.
    const medium = asArray(meta.Media)[0];
    const part =
      typeof medium === "object" && medium !== null
        ? asArray((medium as { Part?: unknown }).Part)[0]
        : undefined;
    const partIdRaw =
      typeof part === "object" && part !== null
        ? (part as { id?: unknown }).id
        : undefined;
    const partId =
      partIdRaw !== undefined && partIdRaw !== null
        ? String(partIdRaw)
        : null;
    const streams =
      typeof part === "object" && part !== null
        ? asArray((part as { Stream?: unknown }).Stream)
        : [];

    // Split the part's streams by streamType: 1 is video and gets ignored, 2 is
    // audio, 3 is subtitles. Anything without an id is unusable, since the id is
    // the whole point of listing them.
    for (const stream of streams) {
      if (typeof stream !== "object" || stream === null) {
        continue;
      }
      const row = stream as {
        id?: unknown;
        streamType?: unknown;
        language?: unknown;
        codec?: unknown;
        channels?: unknown;
        title?: unknown;
        default?: unknown;
        forced?: unknown;
        key?: unknown;
      };
      if (row.id === undefined || row.id === null) {
        continue;
      }
      const id = String(row.id);
      const language =
        typeof row.language === "string" ? row.language : null;
      const codec = typeof row.codec === "string" ? row.codec : null;
      const title = typeof row.title === "string" ? row.title : null;

      // `default` and `forced` arrive as 0/1 rather than booleans, so both go
      // through plexBool.
      if (row.streamType === 2) {
        audio.push({
          id,
          language,
          codec,
          channels: typeof row.channels === "number" ? row.channels : null,
          title,
          default: plexBool(row.default),
        });
      } else if (row.streamType === 3) {
        subtitle.push({
          id,
          language,
          codec,
          title,
          forced: plexBool(row.forced),
          external: typeof row.key === "string" && row.key.length > 0,
          // Heuristic: text-based codecs that can become sidecar VTT.
          // Unknown codecs are treated as non-text (image/burn-in).
          textBased: isTextBasedSubtitleCodec(codec),
        });
      }
    }

    // Titles are shaped here rather than in the player, so the browser doesn't
    // have to know Plex's parent/grandparent naming to draw a header.
    const { title, subheading } = playbackDisplayFromMetadata(meta);

    return {
      durationMs,
      creditsOffsetMs,
      partId,
      audio,
      subtitle,
      title,
      subheading,
      viewOffsetMs,
    };
  }

  /**
   * The movie and show libraries on the server.
   *
   * Sections come back as `Directory` rows, not `Metadata`, which is the first
   * thing that catches you out on this endpoint. Music and photo sections are
   * dropped here so nothing downstream has to think about types the app can't
   * browse or play.
   */
  async function sections(): Promise<LibrarySection[]> {
    const body = await getJson("/library/sections");
    const rows = asArray(mediaContainer(body)?.Directory);
    const result: LibrarySection[] = [];

    for (const row of rows) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const key = (row as { key?: unknown }).key;
      const title = (row as { title?: unknown }).title;
      const type = (row as { type?: unknown }).type;
      if (key === undefined || key === null) {
        continue;
      }
      if (typeof title !== "string") {
        continue;
      }
      if (type !== "movie" && type !== "show") {
        continue;
      }
      result.push({ key: String(key), title, type });
    }

    return result;
  }

  /**
   * One page of a library section: the Library grid's whole data source.
   *
   * Every filter is applied by Plex, not in the browser. That's what makes
   * search cover the entire section rather than the page you happen to be
   * looking at, and it's why sorting and genre filtering stay correct across
   * pages.
   *
   * @param genre the numeric genre id from sectionGenres, not a genre name.
   * @param firstCharacter a letter from sectionFirstCharacters, which switches
   * the request to a different endpoint entirely (see below).
   * @param title substring to match on. This is the Library search box, and it
   * arrives on our own API as `query`, so the rename happens in the route.
   * @param userToken the acting user's per-server token. Without it, the
   * viewOffset, viewCount and lastViewedAt on every row belong to the owner,
   * which is why routes/library.ts nulls those three out when it has no token.
   * @throws PlexServerUpstreamError on any upstream failure.
   */
  async function sectionItems(options: {
    sectionKey: string;
    sort: LibrarySortKey;
    start: number;
    size: number;
    genre?: string;
    unwatched?: boolean;
    firstCharacter?: string;
    title?: string;
    userToken?: string;
  }): Promise<{ items: LibraryItem[]; totalSize: number }> {
    const {
      sectionKey,
      sort,
      start,
      size,
      genre,
      unwatched,
      firstCharacter,
      title,
      userToken,
    } = options;
    // includeGuids=1 is what puts the Guid rows in the response, and no Guid
    // rows means no TMDB id, which means no join to the discovery side of the
    // app. Paging rides on the same X-Plex-Container-* query params as history().
    const query: Record<string, string> = {
      sort: mapLibrarySort(sort),
      includeGuids: "1",
      "X-Plex-Container-Start": String(start),
      "X-Plex-Container-Size": String(size),
    };
    // Optional filters are only emitted when set. unwatched goes out as "1" or
    // not at all; a false never reaches the wire as unwatched=0.
    if (genre !== undefined) {
      query.genre = genre;
    }
    if (unwatched) {
      query.unwatched = "1";
    }
    if (title !== undefined) {
      query.title = title;
    }

    // The A-Z rail doesn't filter /all, it swaps to a different path. Every
    // query param above still applies, so a letter can be combined with a genre
    // or with unwatched. encodeURIComponent matters for the "#" bucket, which
    // has to go over the wire as %23.
    const path =
      firstCharacter !== undefined
        ? `/library/sections/${sectionKey}/firstCharacter/${encodeURIComponent(firstCharacter)}`
        : `/library/sections/${sectionKey}/all`;

    const body =
      userToken !== undefined
        ? await getJsonWithToken(path, userToken, query)
        : await getJson(path, query);

    const container = mediaContainer(body);
    const rows = asArray(container?.Metadata);
    const items: LibraryItem[] = [];

    // Field-by-field, best effort. Nothing here throws on a weird row: a title
    // with no ratingKey is skipped outright and anything else that doesn't match
    // its expected type lands as null. One bad record shouldn't blank a page of
    // posters.
    for (const row of rows) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const ratingKey = (row as { ratingKey?: unknown }).ratingKey;
      if (ratingKey === undefined || ratingKey === null) {
        continue;
      }

      const typeRaw = (row as { type?: unknown }).type;
      const titleRaw = (row as { title?: unknown }).title;
      const yearRaw = (row as { year?: unknown }).year;
      const thumbRaw = (row as { thumb?: unknown }).thumb;
      const addedAtRaw = (row as { addedAt?: unknown }).addedAt;
      const guidRaw = (row as { Guid?: unknown }).Guid;
      const summaryRaw = (row as { summary?: unknown }).summary;
      const audienceRatingRaw = (row as { audienceRating?: unknown }).audienceRating;
      const ratingRaw = (row as { rating?: unknown }).rating;
      const contentRatingRaw = (row as { contentRating?: unknown }).contentRating;
      const durationRaw = (row as { duration?: unknown }).duration;
      const genreRaw = (row as { Genre?: unknown }).Genre;
      const viewOffsetRaw = (row as { viewOffset?: unknown }).viewOffset;
      const viewCountRaw = (row as { viewCount?: unknown }).viewCount;
      const lastViewedAtRaw = (row as { lastViewedAt?: unknown }).lastViewedAt;

      // Genres arrive as objects carrying a `tag`, so flatten to plain strings.
      // Deliberately strict about Array here rather than using asArray, so a
      // scalar Genre yields [] instead of one junk entry.
      const genres: string[] = [];
      if (Array.isArray(genreRaw)) {
        for (const entry of genreRaw) {
          if (
            entry &&
            typeof entry === "object" &&
            typeof (entry as { tag?: unknown }).tag === "string"
          ) {
            genres.push((entry as { tag: string }).tag);
          }
        }
      }

      items.push({
        ratingKey: String(ratingKey),
        type: typeof typeRaw === "string" ? typeRaw : "",
        title: typeof titleRaw === "string" ? titleRaw : "",
        year: typeof yearRaw === "number" ? yearRaw : null,
        thumb: typeof thumbRaw === "string" ? thumbRaw : null,
        addedAt: typeof addedAtRaw === "number" ? addedAtRaw : null,
        tmdbId: tmdbIdFromGuids(guidRaw),
        summary: typeof summaryRaw === "string" ? summaryRaw : null,
        // Plex carries two scores on a row. audienceRating is preferred and
        // `rating`, the critic score, is the fallback.
        rating:
          typeof audienceRatingRaw === "number"
            ? audienceRatingRaw
            : typeof ratingRaw === "number"
              ? ratingRaw
              : null,
        contentRating:
          typeof contentRatingRaw === "string" ? contentRatingRaw : null,
        // Plex only gives duration in ms. Both forms go out: minutes for
        // display, raw ms for progress math.
        runtime:
          typeof durationRaw === "number"
            ? Math.round(durationRaw / 60000)
            : null,
        durationMs:
          typeof durationRaw === "number" ? durationRaw : null,
        genres,
        viewOffset:
          typeof viewOffsetRaw === "number" ? viewOffsetRaw : null,
        viewCount: typeof viewCountRaw === "number" ? viewCountRaw : null,
        lastViewedAt:
          typeof lastViewedAtRaw === "number" ? lastViewedAtRaw : null,
      });
    }

    // totalSize is the count of everything matching the filter, and it drives
    // the grid's paging. Not every response carries one, so fall back to the
    // container's `size` and finally to however many rows actually parsed.
    // Guessing low here just means the grid stops scrolling early.
    const totalSize =
      typeof container?.totalSize === "number"
        ? container.totalSize
        : typeof container?.size === "number"
          ? container.size
          : items.length;

    return { items, totalSize };
  }

  // Per-account "continue watching" list from Plex On Deck. Must use the
  // acting user's token — the owner token would return the owner's deck.
  //
  // Movies and episodes come back mixed in one Metadata array and get flattened
  // into a single card shape. Any other type (a season row, say) is dropped, and
  // Plex's ordering is kept as-is.
  async function onDeck(userToken: string): Promise<OnDeckItem[]> {
    const body = await getJsonWithToken("/library/onDeck", userToken);
    const rows = asArray(mediaContainer(body)?.Metadata);
    const items: OnDeckItem[] = [];

    for (const row of rows) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const ratingKey = (row as { ratingKey?: unknown }).ratingKey;
      const typeRaw = (row as { type?: unknown }).type;
      if (ratingKey === undefined || ratingKey === null) {
        continue;
      }
      if (typeRaw !== "movie" && typeRaw !== "episode") {
        continue;
      }

      const titleRaw = (row as { title?: unknown }).title;
      const yearRaw = (row as { year?: unknown }).year;
      const thumbRaw = (row as { thumb?: unknown }).thumb;
      const grandparentTitleRaw = (row as { grandparentTitle?: unknown })
        .grandparentTitle;
      const grandparentThumbRaw = (row as { grandparentThumb?: unknown })
        .grandparentThumb;
      const parentIndexRaw = (row as { parentIndex?: unknown }).parentIndex;
      const indexRaw = (row as { index?: unknown }).index;
      const viewOffsetRaw = (row as { viewOffset?: unknown }).viewOffset;
      const durationRaw = (row as { duration?: unknown }).duration;

      let title: string;
      let subtitle: string | null;
      let thumb: string | null;

      // A movie labels itself. An episode has to borrow from its show: the
      // grandparent's title and artwork, with S#E# as the subtitle, so the rail
      // reads "Friends / S1E1" instead of an episode name with no context. The
      // episode's own title and thumb are the fallback.
      if (typeRaw === "movie") {
        title = typeof titleRaw === "string" ? titleRaw : "";
        subtitle = typeof yearRaw === "number" ? String(yearRaw) : null;
        thumb = typeof thumbRaw === "string" ? thumbRaw : null;
      } else {
        title =
          typeof grandparentTitleRaw === "string" &&
          grandparentTitleRaw.length > 0
            ? grandparentTitleRaw
            : typeof titleRaw === "string"
              ? titleRaw
              : "";
        const parentIndex =
          typeof parentIndexRaw === "number" ? parentIndexRaw : null;
        const index = typeof indexRaw === "number" ? indexRaw : null;
        subtitle =
          parentIndex !== null && index !== null
            ? `S${parentIndex}E${index}`
            : null;
        thumb =
          typeof grandparentThumbRaw === "string"
            ? grandparentThumbRaw
            : typeof thumbRaw === "string"
              ? thumbRaw
              : null;
      }

      items.push({
        ratingKey: String(ratingKey),
        type: typeRaw,
        title,
        subtitle,
        thumb,
        viewOffset:
          typeof viewOffsetRaw === "number" ? viewOffsetRaw : null,
        duration: typeof durationRaw === "number" ? durationRaw : null,
      });
    }

    return items;
  }

  /**
   * Genres present in a section, for the Library's genre dropdown.
   *
   * The `id` is Plex's internal genre key, and it's what sectionItems wants back
   * as its `genre` filter. Not the name. The list is fetched per section, and it
   * goes out on the owner token since it's the same for everyone.
   */
  async function sectionGenres(
    sectionKey: string,
  ): Promise<{ id: string; title: string }[]> {
    const body = await getJson(`/library/sections/${sectionKey}/genre`);
    const rows = asArray(mediaContainer(body)?.Directory);
    const result: { id: string; title: string }[] = [];

    for (const row of rows) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const key = (row as { key?: unknown }).key;
      const title = (row as { title?: unknown }).title;
      if (key === undefined || key === null) {
        continue;
      }
      if (typeof title !== "string") {
        continue;
      }
      result.push({ id: String(key), title });
    }

    return result;
  }

  /**
   * Buckets for the A-Z rail: each starting letter with how many titles sit
   * under it. "#" is one of the labels, and it's the one that has to survive URL
   * encoding when it goes back to sectionItems as a firstCharacter.
   *
   * Careful with `size` here. On a MediaContainer it counts the rows in the
   * response, but on one of these Directory rows it's how many titles fall under
   * that letter, which is what gets read into `count`.
   */
  async function sectionFirstCharacters(
    sectionKey: string,
  ): Promise<{ label: string; count: number }[]> {
    const body = await getJson(
      `/library/sections/${sectionKey}/firstCharacter`,
    );
    const rows = asArray(mediaContainer(body)?.Directory);
    const result: { label: string; count: number }[] = [];

    for (const row of rows) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const title = (row as { title?: unknown }).title;
      const size = (row as { size?: unknown }).size;
      if (typeof title !== "string") {
        continue;
      }
      result.push({
        label: title,
        count: typeof size === "number" ? size : 0,
      });
    }

    return result;
  }

  /**
   * Pulls poster and art bytes off the PMS so the browser never needs a Plex
   * token or a route to the server. routes/library.ts re-serves the result from
   * our own origin behind /api/library/image.
   *
   * The odd one out in this file: a non-OK upstream comes back as `ok: false`
   * with an empty body instead of throwing, so a single missing poster doesn't
   * turn into a 502. Only a network-level failure throws.
   *
   * @param path a Plex-relative image path. The caller validates its shape;
   * nothing here stops it being pointed at another endpoint.
   * @throws PlexServerUpstreamError when the request never completes.
   */
  async function fetchImage(path: string): Promise<{
    ok: boolean;
    status: number;
    contentType: string | null;
    body: Buffer;
  }> {
    const url = `${baseUrl}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "X-Plex-Token": token,
        },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Plex server request failed";
      throw new PlexServerUpstreamError(message, 502);
    }

    // Read whole into memory rather than streamed through. Fine for posters,
    // wrong for anything big. The content type is passed along so the route can
    // set it without sniffing the bytes.
    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        contentType: res.headers.get("content-type"),
        body: Buffer.from(await res.arrayBuffer()),
      };
    }

    // Non-OK still returns a value. The body is dropped rather than forwarded,
    // since a Plex error page isn't an image and the caller only checks `ok`.
    return {
      ok: false,
      status: res.status,
      contentType: res.headers.get("content-type"),
      body: Buffer.alloc(0),
    };
  }

  // Selects (or clears with subtitleStreamID "0") the burned-in subtitle for
  // the calling user on a media part. Uses the USER's token — selection is
  // per-account on the Plex server, not the owner token.
  //
  // Two things to know. It's a PUT with the selection in the query string and no
  // body at all, and it targets the PART id (from playbackMeta) rather than the
  // ratingKey, so picking a subtitle is always a metadata fetch followed by this
  // call. Selection is state that lives on the server, so the stream has to be
  // restarted afterward for Plex to re-decide with it (see selectSubtitle in
  // web/src/api/watch.ts).
  async function selectSubtitle(
    partId: string,
    subtitleStreamID: string,
    userToken: string,
  ): Promise<void> {
    const path = `/library/parts/${partId}`;
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set("subtitleStreamID", subtitleStreamID);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "PUT",
        headers: {
          "X-Plex-Token": userToken,
          Accept: "application/json",
        },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Plex server request failed";
      throw new PlexServerUpstreamError(message, 502);
    }

    if (!res.ok) {
      throw new PlexServerUpstreamError(
        `Plex server ${path} failed (${res.status})`,
        res.status,
      );
    }
  }

  // Reports one playback timeline event for the calling user so Plex can
  // update resume position / watched state. Param set is UNVERIFIED against
  // a live PMS — keep the query construction easy to adjust. Uses the USER's
  // token (not the owner token), like selectSubtitle.
  //
  // The write side of per-user watch state. Everything the app reads back later
  // (On Deck, the progress bars on posters, the resume prompt) starts here. Since
  // it writes to the user's account on the server itself, a title started on the
  // TV picks up in the browser and the other way round.
  //
  // Shape worth knowing: it's a GET rather than a POST, everything including the
  // token rides in the query string, and both `ratingKey` and `key` go out even
  // though `key` is just the metadata path built from that same ratingKey. time
  // and duration are milliseconds.
  async function reportTimeline(args: {
    ratingKey: string;
    state: "playing" | "paused" | "stopped";
    timeMs: number;
    durationMs: number;
    userToken: string;
    clientId: string;
  }): Promise<void> {
    const path = "/:/timeline";
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set("ratingKey", args.ratingKey);
    url.searchParams.set("key", `/library/metadata/${args.ratingKey}`);
    url.searchParams.set("state", args.state);
    url.searchParams.set("time", String(args.timeMs));
    url.searchParams.set("duration", String(args.durationMs));
    url.searchParams.set("X-Plex-Token", args.userToken);
    url.searchParams.set("X-Plex-Client-Identifier", args.clientId);

    let res: Response;
    try {
      res = await fetch(url, { method: "GET" });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Plex server request failed";
      throw new PlexServerUpstreamError(message, 502);
    }

    if (!res.ok) {
      throw new PlexServerUpstreamError(
        `Plex server ${path} failed (${res.status})`,
        res.status,
      );
    }
  }

  // The public surface. Anything not listed here (getJson, fetchMovie,
  // fetchShow) stays private, which is what lets the internals change without
  // touching the routers.
  return {
    accounts,
    history,
    item,
    episodes,
    nextEpisode,
    playbackMeta,
    sections,
    sectionItems,
    onDeck,
    sectionGenres,
    sectionFirstCharacters,
    fetchImage,
    selectSubtitle,
    reportTimeline,
  };
}

// Inferred from the factory rather than declared, so the type can't drift from
// what's actually returned. Route deps take this; tests hand in a partial object
// cast to it.
export type PlexServerClient = ReturnType<typeof createPlexServerClient>;

// Unwraps the MediaContainer envelope every Plex response arrives in. Returns
// null rather than throwing when the body isn't shaped like one, which pushes
// the decision about whether that's fatal out to the caller.
function mediaContainer(
  body: unknown,
): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const container = (body as { MediaContainer?: unknown }).MediaContainer;
  if (typeof container !== "object" || container === null) {
    return null;
  }
  return container as Record<string, unknown>;
}

// Normalizes a Plex child collection to an array. Covers both the missing
// collection (absent key, not an empty array) and the single child that arrives
// as a bare object rather than a one-element list. Every loop in this file runs
// through here instead of repeating an Array.isArray check at each site.
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

// Pulls the one Metadata row out of a single-item lookup. Plex still wraps a
// single item in a container holding a list, so "get this movie" means "take the
// first element". Null means the response came back fine but had nothing usable
// in it; most callers turn that into a 502, though fetchShow shrugs and carries
// on with an empty title. The returned shape only names the fields this file
// reads. The live payload carries far more.
function firstMetadata(
  body: unknown,
): {
  title?: unknown;
  year?: unknown;
  grandparentTitle?: unknown;
  parentIndex?: unknown;
  index?: unknown;
  Media?: unknown;
  duration?: unknown;
  viewOffset?: unknown;
  grandparentRatingKey?: unknown;
  Marker?: unknown;
} | null {
  const rows = asArray(mediaContainer(body)?.Metadata);
  const first = rows[0];
  if (typeof first !== "object" || first === null) {
    return null;
  }
  return first as {
    title?: unknown;
    year?: unknown;
    grandparentTitle?: unknown;
    parentIndex?: unknown;
    index?: unknown;
    Media?: unknown;
    duration?: unknown;
    viewOffset?: unknown;
    grandparentRatingKey?: unknown;
    Marker?: unknown;
  };
}

// Turns a metadata row into the two strings the player header shows.
//
// grandparentTitle is the tell for an episode: if it's there, the show becomes
// the title and the episode detail drops to the subheading as "S1E1 · Pilot".
// An episode with no season or episode number (a special, say) falls back to
// just its own title. Otherwise it's treated as a movie and the year becomes the
// subheading.
function playbackDisplayFromMetadata(meta: {
  title?: unknown;
  year?: unknown;
  grandparentTitle?: unknown;
  parentIndex?: unknown;
  index?: unknown;
}): { title: string | null; subheading: string | null } {
  const grandparentTitle =
    typeof meta.grandparentTitle === "string" && meta.grandparentTitle.length > 0
      ? meta.grandparentTitle
      : null;

  if (grandparentTitle !== null) {
    const episodeTitle =
      typeof meta.title === "string" && meta.title.length > 0
        ? meta.title
        : null;
    const parentIndex =
      typeof meta.parentIndex === "number" ? meta.parentIndex : null;
    const index = typeof meta.index === "number" ? meta.index : null;

    if (parentIndex !== null && index !== null) {
      let subheading = `S${parentIndex}E${index}`;
      if (episodeTitle !== null) {
        subheading += ` · ${episodeTitle}`;
      }
      return { title: grandparentTitle, subheading };
    }

    return {
      title: grandparentTitle,
      subheading: episodeTitle,
    };
  }

  const title =
    typeof meta.title === "string" && meta.title.length > 0 ? meta.title : null;
  const subheading =
    typeof meta.year === "number" ? String(meta.year) : null;
  return { title, subheading };
}

// Prefer final credits; else the credits marker with the greatest start.
// Missing/malformed markers soft-fail to null — never throw.
//
// An item can carry several markers at once (the fixtures show an intro marker
// alongside two credits markers), so the list gets filtered to type "credits"
// and reduced to a single offset. `final` arrives as a boolean on some rows and
// as 0/1 on others, hence plexBool. A null result means no usable credits
// marker, which is a normal outcome and not an error.
function creditsOffsetFromMarkers(markers: unknown): number | null {
  let finalOffset: number | null = null;
  let latestOffset: number | null = null;

  for (const row of asArray(markers)) {
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const marker = row as {
      type?: unknown;
      startTimeOffset?: unknown;
      final?: unknown;
    };
    if (marker.type !== "credits") {
      continue;
    }
    const offset = marker.startTimeOffset;
    if (
      typeof offset !== "number" ||
      !Number.isFinite(offset) ||
      offset < 0
    ) {
      continue;
    }
    if (latestOffset === null || offset > latestOffset) {
      latestOffset = offset;
    }
    if (plexBool(marker.final)) {
      if (finalOffset === null || offset > finalOffset) {
        finalOffset = offset;
      }
    }
  }

  return finalOffset ?? latestOffset;
}

// Total bytes across every Media and every Part on an item. The nesting is
// Plex's: an item holds Media entries (separate versions, per the note in
// playbackMeta) and each Media holds Parts. Nothing is filtered, so an item kept
// in more than one version reports the sum of all of them.
function sumMediaPartSizes(media: unknown): number {
  let total = 0;
  for (const medium of asArray(media)) {
    if (typeof medium !== "object" || medium === null) {
      continue;
    }
    for (const part of asArray((medium as { Part?: unknown }).Part)) {
      if (typeof part !== "object" || part === null) {
        continue;
      }
      const size = (part as { size?: unknown }).size;
      if (typeof size === "number") {
        total += size;
      }
    }
  }
  return total;
}

// Plex flags come back as true, as 1, or as "1" depending on where you're
// reading them. The fixtures even have `final` showing up both ways. Anything
// else, a missing field included, is false.
function plexBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

const TMDB_GUID_RE = /^tmdb:\/\/(\d+)$/;

// Finds the TMDB id in an item's Guid rows. This is the join between the Plex
// half of the app and the TMDB/Seerr half. An item carries more than one guid
// (the fixtures pair tmdb:// with imdb://), so the rows get scanned for the tmdb
// one and the rest ignored. The regex is anchored at both ends, so a guid that
// merely contains "tmdb://" won't match. Null is a real answer rather than a
// failure: an item Plex matched some other way still plays, straight off its
// ratingKey.
function tmdbIdFromGuids(guids: unknown): number | null {
  for (const row of asArray(guids)) {
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const id = (row as { id?: unknown }).id;
    if (typeof id !== "string") {
      continue;
    }
    const match = TMDB_GUID_RE.exec(id);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

// Whether a subtitle codec is text rather than an image. A fixed allow-list, not
// something Plex reports, so anything unrecognized comes back false and gets
// treated as image/burn-in per the note in playbackMeta. pgs, which shows up in
// the fixtures, is one of the ones that falls through.
function isTextBasedSubtitleCodec(codec: string | null): boolean {
  if (codec === null) {
    return false;
  }
  switch (codec.toLowerCase()) {
    case "srt":
    case "subrip":
    case "ass":
    case "ssa":
    case "mov_text":
    case "webvtt":
    case "text":
      return true;
    default:
      return false;
  }
}
