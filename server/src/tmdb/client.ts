// Read-only client for TMDB, the source of everything discovery-side: search,
// trending, genres, cast and crew, collections, artwork. Plex knows what's on
// the server. TMDB knows what exists.
//
// createTmdbClient() runs once in server/src/index.ts and feeds the
// /api/discover router, the requests router (which needs a title and poster for
// each Seerr request) and the enrichment cache. The API key rides the query
// string and never reaches the browser.
//
// Two conventions to know before reading the mappers. TMDB speaks snake_case
// and this file is the boundary where it becomes camelCase. And `media_type`
// only comes back on the mixed endpoints like /search/multi, so every
// single-type call passes a defaultMediaType into mapMediaSummary to fill the
// gap.
//
// Poster and profile paths are expanded to absolute w500 URLs here, so the
// frontend never has to know the CDN layout. That origin is also allowlisted in
// the CSP in index.ts, which is worth remembering if the size ever changes.

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";

// The card shape. Every browse surface in the app renders one of these, which
// is why so many of the endpoints below funnel into the same mapper.
export type MediaSummary = {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string; // TMDB's `title` for movies, `name` for shows
  year: number | null; // null when the release date is missing or unparseable
  posterUrl: string | null;
  overview: string; // empty string rather than null, so the UI can render it directly
};

// Backs the movie title page.
export type MovieDetail = {
  tmdbId: number;
  mediaType: "movie";
  title: string;
  year: number | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  runtime: number | null; // minutes
  genres: string[]; // names only; the ids aren't needed once a title is open
  status: string; // TMDB's release status, e.g. "Released". Empty when absent.
  collection: {
    id: number;
    name: string;
  } | null; // the franchise this belongs to, if any
};

// Real seasons only. Season 0 (specials) is filtered out in mapTvSeasons.
export type TvSeasonSummary = {
  seasonNumber: number;
  name: string;
  episodeCount: number;
};

// Backs the show title page, including the per-season request checkboxes.
export type TvDetail = {
  tmdbId: number;
  mediaType: "tv";
  title: string; // TMDB calls this `name` for shows
  year: number | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  genres: string[];
  status: string; // e.g. "Ended", "Returning Series"
  tvdbId: number | null; // Sonarr's id system, pulled from external_ids
  seasons: TvSeasonSummary[];
};

// A paged browse response. `page` and `totalPages` come straight from TMDB so
// the frontend can drive its own pagination.
export type SearchResult = {
  page: number;
  totalPages: number;
  results: MediaSummary[];
};

// A genre filter option. The id is what discover() passes back as with_genres.
export type Genre = {
  id: number;
  name: string;
};

export type CastCredit = {
  id: number; // TMDB person id, links through to the person page
  name: string;
  character: string; // empty string when TMDB doesn't give one
  profileUrl: string | null;
};

export type CrewCredit = {
  id: number;
  name: string;
  job: string; // one person's multiple jobs get joined with " / "
  profileUrl: string | null;
};

export type PersonDetail = {
  id: number;
  name: string;
  biography: string;
  profileUrl: string | null;
  knownForDepartment: string;
  birthday: string | null; // ISO date string as TMDB sends it, not a Date
  placeOfBirth: string | null;
};

// A franchise page, like the Matrix collection. `parts` is sorted oldest first.
export type CollectionDetail = {
  id: number;
  name: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  parts: MediaSummary[];
};

// Filters for a browse page. companyId only applies to movies and networkId
// only to TV, which discover() enforces rather than trusting the caller.
export type DiscoverOptions = {
  genreId?: number;
  companyId?: number; // production company, from tmdb/studios.ts STUDIOS
  networkId?: number; // TV network, from tmdb/studios.ts NETWORKS
  page?: number; // 1-based; defaults to 1
};

/**
 * Any failure talking to TMDB.
 *
 * `status` is TMDB's own code when there was a response, and 502 when the fetch
 * threw or the body wasn't the shape we expect.
 *
 * Nothing reads `status` today. Every route that catches this answers a flat
 * 502 and only uses `.message`, so a TMDB 404 on an unknown id still surfaces
 * to the client as 502. The field is here for whenever a route wants to pass
 * the real code through.
 */
export class TmdbUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TmdbUpstreamError";
    this.status = status;
  }
}

export type TmdbClientOptions = {
  apiKey: string; // v3 API key, sent as the api_key query param
};

/**
 * Builds the TMDB client. One instance at startup, shared by every caller.
 *
 * No caching lives in here. createMediaEnrichment() wraps the detail calls with
 * a ten-minute cache for the poster and title lookups that get hit repeatedly;
 * everything else goes to TMDB each time.
 */
export function createTmdbClient(options: TmdbClientOptions) {
  const { apiKey } = options;

  // Single fetch chokepoint, same pattern as the Seerr client. The API key is
  // attached here so no individual call can forget it.
  async function getJson(
    path: string,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    const url = new URL(`${TMDB_BASE}${path}`);
    url.searchParams.set("api_key", apiKey);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });
    } catch (err) {
      // Nothing came back at all, so there's no upstream status to forward.
      const message =
        err instanceof Error ? err.message : "TMDB request failed";
      throw new TmdbUpstreamError(message, 502);
    }

    // TMDB's own status is kept on the error object, but no route forwards it
    // today (see the TmdbUpstreamError note above), so a 404 on an unknown id
    // still reaches the browser as a 502.
    if (!res.ok) {
      throw new TmdbUpstreamError(
        `TMDB ${path} failed (${res.status})`,
        res.status,
      );
    }

    return res.json();
  }

  /**
   * Global search across movies, shows and people.
   *
   * /search/multi returns people too. They're dropped in the mapping, because
   * mapMediaSummary only accepts movie or tv, so a page can legitimately come
   * back with fewer results than TMDB counted.
   *
   * @throws TmdbUpstreamError on a bad status or a body without page metadata.
   */
  async function search(query: string, page = 1): Promise<SearchResult> {
    const body = await getJson("/search/multi", {
      query,
      page: String(page),
      include_adult: "false",
    });

    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { page?: unknown }).page !== "number" ||
      typeof (body as { total_pages?: unknown }).total_pages !== "number" ||
      !Array.isArray((body as { results?: unknown }).results)
    ) {
      throw new TmdbUpstreamError(
        "TMDB search returned unexpected body",
        502,
      );
    }

    const results: MediaSummary[] = [];
    for (const row of (body as { results: unknown[] }).results) {
      const mapped = mapMediaSummary(row);
      if (mapped !== null) {
        results.push(mapped);
      }
    }

    return {
      page: (body as { page: number }).page,
      totalPages: (body as { total_pages: number }).total_pages,
      results,
    };
  }

  /**
   * This week's global trending list, movies and shows mixed. It's the top rail
   * on Discover, with Plex availability layered on by the route.
   *
   * @throws TmdbUpstreamError on a bad status or a body with no results array.
   */
  async function trending(): Promise<MediaSummary[]> {
    const body = await getJson("/trending/all/week");

    if (
      typeof body !== "object" ||
      body === null ||
      !Array.isArray((body as { results?: unknown }).results)
    ) {
      throw new TmdbUpstreamError(
        "TMDB trending returned unexpected body",
        502,
      );
    }

    const results: MediaSummary[] = [];
    for (const row of (body as { results: unknown[] }).results) {
      const mapped = mapMediaSummary(row);
      if (mapped !== null) {
        results.push(mapped);
      }
    }
    return results;
  }

  /**
   * What's coming, capped at 20 for the rail.
   *
   * The TV equivalent of "upcoming" is /tv/on_the_air, so the two media types
   * hit different endpoints. Neither one sets media_type on its rows, hence the
   * explicit default passed to the mapper.
   *
   * @throws TmdbUpstreamError on a bad status or a body with no results array.
   */
  async function upcoming(
    mediaType: "movie" | "tv",
  ): Promise<MediaSummary[]> {
    const path =
      mediaType === "movie" ? "/movie/upcoming" : "/tv/on_the_air";
    const body = await getJson(path);
    if (
      typeof body !== "object" ||
      body === null ||
      !Array.isArray((body as { results?: unknown }).results)
    ) {
      throw new TmdbUpstreamError(
        "TMDB upcoming returned unexpected body",
        502,
      );
    }

    const results: MediaSummary[] = [];
    for (const row of (body as { results: unknown[] }).results) {
      const mapped = mapMediaSummary(row, mediaType);
      if (mapped !== null) {
        results.push(mapped);
      }
      if (results.length === 20) {
        break;
      }
    }
    return results;
  }

  /**
   * The genre list for the browse filter dropdown. TMDB publishes a separate
   * list per media type, so this gets asked once for movies and once for TV.
   *
   * Malformed rows are skipped rather than fatal.
   *
   * @throws TmdbUpstreamError on a bad status or a body with no genres array.
   */
  async function genres(mediaType: "movie" | "tv"): Promise<Genre[]> {
    const body = await getJson(`/genre/${mediaType}/list`);
    if (
      typeof body !== "object" ||
      body === null ||
      !Array.isArray((body as { genres?: unknown }).genres)
    ) {
      throw new TmdbUpstreamError(
        "TMDB genres returned unexpected body",
        502,
      );
    }

    const results: Genre[] = [];
    for (const row of (body as { genres: unknown[] }).genres) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const id = (row as { id?: unknown }).id;
      const name = (row as { name?: unknown }).name;
      if (typeof id === "number" && typeof name === "string") {
        results.push({ id, name });
      }
    }
    return results;
  }

  /**
   * The filtered browse endpoint behind the genre, studio and network pages.
   * Always sorted by popularity, always paged.
   *
   * @throws TmdbUpstreamError on a bad status or a body without page metadata.
   */
  async function discover(
    mediaType: "movie" | "tv",
    options: DiscoverOptions = {},
  ): Promise<SearchResult> {
    const query: Record<string, string> = {
      sort_by: "popularity.desc",
      include_adult: "false",
      page: String(options.page ?? 1),
    };
    if (options.genreId !== undefined) {
      query.with_genres = String(options.genreId);
    }
    // Companies are a movie filter and networks are a TV filter. Pairing either
    // one with the wrong media type is silently ignored instead of sent, which
    // keeps a stale frontend from producing a nonsense query.
    if (mediaType === "movie" && options.companyId !== undefined) {
      query.with_companies = String(options.companyId);
    }
    if (mediaType === "tv" && options.networkId !== undefined) {
      query.with_networks = String(options.networkId);
    }

    const body = await getJson(`/discover/${mediaType}`, query);
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { page?: unknown }).page !== "number" ||
      typeof (body as { total_pages?: unknown }).total_pages !== "number" ||
      !Array.isArray((body as { results?: unknown }).results)
    ) {
      throw new TmdbUpstreamError(
        "TMDB discover returned unexpected body",
        502,
      );
    }

    const results: MediaSummary[] = [];
    for (const row of (body as { results: unknown[] }).results) {
      const mapped = mapMediaSummary(row, mediaType);
      if (mapped !== null) {
        results.push(mapped);
      }
    }

    return {
      page: (body as { page: number }).page,
      totalPages: (body as { total_pages: number }).total_pages,
      results,
    };
  }

  /**
   * The "more like this" rail on a title page, capped at 20.
   *
   * Falls back to /similar when /recommendations comes back empty, so a title
   * nobody has rated still gets a rail. The two passes read media type
   * differently: the recommendations rows are trusted to carry their own
   * media_type, and the similar rows are given the type that was asked for.
   *
   * @throws TmdbUpstreamError on a bad status or a body with no results array.
   */
  async function recommendations(
    mediaType: "movie" | "tv",
    id: number,
  ): Promise<MediaSummary[]> {
    // Both endpoints return the same envelope, so the mapping is shared. The
    // source title is excluded from its own recommendations.
    const mapResults = (
      body: unknown,
      defaultMediaType?: "movie" | "tv",
    ): MediaSummary[] => {
      if (
        typeof body !== "object" ||
        body === null ||
        !Array.isArray((body as { results?: unknown }).results)
      ) {
        throw new TmdbUpstreamError(
          "TMDB recommendations returned unexpected body",
          502,
        );
      }

      const results: MediaSummary[] = [];
      for (const row of (body as { results: unknown[] }).results) {
        const mapped = mapMediaSummary(row, defaultMediaType);
        if (mapped !== null && mapped.tmdbId !== id) {
          results.push(mapped);
        }
        if (results.length === 20) {
          break;
        }
      }
      return results;
    };

    const recommended = mapResults(
      await getJson(`/${mediaType}/${id}/recommendations`),
    );
    if (recommended.length > 0) {
      return recommended;
    }

    return mapResults(
      await getJson(`/${mediaType}/${id}/similar`),
      mediaType,
    );
  }

  /**
   * Cast and crew for a title page: the top 18 billed actors and up to 8 key
   * crew.
   *
   * Full credits run to hundreds of people, most of them irrelevant to someone
   * deciding what to watch, so both lists are trimmed here rather than in the
   * browser. Crew is filtered to the jobs a viewer actually recognizes and
   * deduplicated per person.
   *
   * @throws TmdbUpstreamError on a bad status or a body missing either array.
   */
  async function credits(
    mediaType: "movie" | "tv",
    id: number,
  ): Promise<{ cast: CastCredit[]; crew: CrewCredit[] }> {
    const body = await getJson(`/${mediaType}/${id}/credits`);
    if (
      typeof body !== "object" ||
      body === null ||
      !Array.isArray((body as { cast?: unknown }).cast) ||
      !Array.isArray((body as { crew?: unknown }).crew)
    ) {
      throw new TmdbUpstreamError(
        "TMDB credits returned unexpected body",
        502,
      );
    }

    // Billing order, top 18. flatMap doubles as the filter: an unusable row
    // returns [] and disappears. The `order` field is carried alongside each
    // credit just long enough to sort on, then dropped, and a row without one
    // sorts to the end rather than jumping to the front.
    const cast = (body as { cast: unknown[] }).cast
      .flatMap((row) => {
        if (typeof row !== "object" || row === null) {
          return [];
        }
        const credit = row as {
          id?: unknown;
          name?: unknown;
          character?: unknown;
          profile_path?: unknown;
          order?: unknown;
        };
        if (
          typeof credit.id !== "number" ||
          typeof credit.name !== "string" ||
          credit.name.trim() === ""
        ) {
          return [];
        }
        return [{
          credit: {
            id: credit.id,
            name: credit.name,
            character:
              typeof credit.character === "string" ? credit.character : "",
            profileUrl: imageUrl(credit.profile_path),
          },
          order: typeof credit.order === "number" ? credit.order : Infinity,
        }];
      })
      .sort((a, b) => a.order - b.order)
      .slice(0, 18)
      .map(({ credit }) => credit);

    // The only crew jobs worth surfacing on a title page. Everything else,
    // composers and editors included, gets dropped.
    const keyJobs = new Set([
      "Director",
      "Creator",
      "Screenplay",
      "Writer",
      "Executive Producer",
      "Producer",
    ]);
    // Keyed by person, because TMDB lists one human once per job they held.
    // Insertion order is preserved, so the eventual slice keeps whoever TMDB
    // listed first. The extra `jobs` array is bookkeeping and is stripped off
    // before the credits are returned.
    const crewByPerson = new Map<
      number,
      CrewCredit & { jobs: string[] }
    >();
    for (const row of (body as { crew: unknown[] }).crew) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const credit = row as {
        id?: unknown;
        name?: unknown;
        job?: unknown;
        profile_path?: unknown;
      };
      if (
        typeof credit.id !== "number" ||
        typeof credit.name !== "string" ||
        credit.name.trim() === "" ||
        typeof credit.job !== "string" ||
        !keyJobs.has(credit.job)
      ) {
        continue;
      }
      // Seen before, so merge the new job into their line rather than listing
      // them twice: "Creator / Executive Producer".
      const existing = crewByPerson.get(credit.id);
      if (existing !== undefined) {
        if (!existing.jobs.includes(credit.job)) {
          existing.jobs.push(credit.job);
          existing.job = existing.jobs.join(" / ");
        }
        continue;
      }
      crewByPerson.set(credit.id, {
        id: credit.id,
        name: credit.name,
        job: credit.job,
        profileUrl: imageUrl(credit.profile_path),
        jobs: [credit.job],
      });
    }
    const crew = [...crewByPerson.values()].slice(0, 8).map(({ jobs, ...credit }) => credit);

    return { cast, crew };
  }

  /**
   * The header of a person page: photo, bio, birthday.
   *
   * Only id and a non-blank name are required. Everything else degrades to an
   * empty string or null, because a missing biography shouldn't stop the page
   * from rendering.
   *
   * @throws TmdbUpstreamError on a bad status or a body with no usable id/name.
   */
  async function person(id: number): Promise<PersonDetail> {
    const body = await getJson(`/person/${id}`);
    if (typeof body !== "object" || body === null) {
      throw new TmdbUpstreamError(
        "TMDB person returned unexpected body",
        502,
      );
    }
    const row = body as {
      id?: unknown;
      name?: unknown;
      biography?: unknown;
      profile_path?: unknown;
      known_for_department?: unknown;
      birthday?: unknown;
      place_of_birth?: unknown;
    };
    if (
      typeof row.id !== "number" ||
      typeof row.name !== "string" ||
      row.name.trim() === ""
    ) {
      throw new TmdbUpstreamError(
        "TMDB person returned unexpected body",
        502,
      );
    }

    return {
      id: row.id,
      name: row.name,
      biography: typeof row.biography === "string" ? row.biography : "",
      profileUrl: imageUrl(row.profile_path),
      knownForDepartment:
        typeof row.known_for_department === "string"
          ? row.known_for_department
          : "",
      birthday:
        typeof row.birthday === "string" && row.birthday !== ""
          ? row.birthday
          : null,
      placeOfBirth:
        typeof row.place_of_birth === "string" && row.place_of_birth !== ""
          ? row.place_of_birth
          : null,
    };
  }

  /**
   * The filmography grid on a person page: their 24 most popular acting
   * credits, movies and shows together.
   *
   * Three passes of cleanup. Credits where the character is "Self" are dropped,
   * which takes out talk show and interview appearances. What's left is ordered
   * by TMDB popularity rather than by date. Then duplicates are collapsed on
   * mediaType plus tmdbId, and because the sort already ran, the copy that
   * survives is the most popular one.
   *
   * @throws TmdbUpstreamError on a bad status or a body with no cast array.
   */
  async function personCredits(id: number): Promise<MediaSummary[]> {
    const body = await getJson(`/person/${id}/combined_credits`);
    if (
      typeof body !== "object" ||
      body === null ||
      !Array.isArray((body as { cast?: unknown }).cast)
    ) {
      throw new TmdbUpstreamError(
        "TMDB person credits returned unexpected body",
        502,
      );
    }

    const mapped = (body as { cast: unknown[] }).cast.flatMap((row) => {
      if (typeof row !== "object" || row === null) {
        return [];
      }
      // "Self" and anything starting "Self " (like "Self - Guest"). The
      // trailing space matters: it keeps a character actually named something
      // like "Selfridge" from being caught.
      const character = (row as { character?: unknown }).character;
      if (
        typeof character === "string" &&
        (character === "Self" || character.startsWith("Self "))
      ) {
        return [];
      }
      const media = mapMediaSummary(row);
      if (media === null) {
        return [];
      }
      const popularity = (row as { popularity?: unknown }).popularity;
      return [{
        media,
        popularity:
          typeof popularity === "number" && Number.isFinite(popularity)
            ? popularity
            : 0,
      }];
    });
    mapped.sort((a, b) => b.popularity - a.popularity);

    // Dedupe after the sort, so the first copy kept is the most popular one.
    const seen = new Set<string>();
    const results: MediaSummary[] = [];
    for (const { media } of mapped) {
      const key = `${media.mediaType}:${media.tmdbId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(media);
      if (results.length === 24) {
        break;
      }
    }
    return results;
  }

  /**
   * A franchise page. Collection parts are always movies, and they come back
   * in release order.
   *
   * @throws TmdbUpstreamError on a bad status, or a body without a parts array
   * or a usable id and name.
   */
  async function collection(id: number): Promise<CollectionDetail> {
    const body = await getJson(`/collection/${id}`);
    if (
      typeof body !== "object" ||
      body === null ||
      !Array.isArray((body as { parts?: unknown }).parts)
    ) {
      throw new TmdbUpstreamError(
        "TMDB collection returned unexpected body",
        502,
      );
    }
    const row = body as {
      id?: unknown;
      name?: unknown;
      overview?: unknown;
      poster_path?: unknown;
      backdrop_path?: unknown;
      parts: unknown[];
    };
    if (typeof row.id !== "number" || typeof row.name !== "string") {
      throw new TmdbUpstreamError(
        "TMDB collection returned unexpected body",
        502,
      );
    }

    // Sort chronologically by release date. Parts announced but not dated come
    // back with an empty release_date, and those go last instead of first,
    // which is what a plain string compare would do.
    const parts = row.parts
      .flatMap((part) => {
        const media = mapMediaSummary(part, "movie");
        if (media === null) {
          return [];
        }
        const releaseDate =
          typeof part === "object" &&
          part !== null &&
          typeof (part as { release_date?: unknown }).release_date === "string"
            ? (part as { release_date: string }).release_date
            : "";
        return [{ media, releaseDate }];
      })
      .sort((a, b) => {
        if (a.releaseDate === "") {
          return b.releaseDate === "" ? 0 : 1;
        }
        if (b.releaseDate === "") {
          return -1;
        }
        return a.releaseDate.localeCompare(b.releaseDate);
      })
      .map(({ media }) => media);

    return {
      id: row.id,
      name: row.name,
      overview: typeof row.overview === "string" ? row.overview : "",
      posterUrl: imageUrl(row.poster_path),
      backdropUrl: imageUrl(row.backdrop_path),
      parts,
    };
  }

  /**
   * Everything the movie title page needs, in one call.
   *
   * Also the workhorse behind request enrichment. Seerr's request rows carry no
   * title or poster, so requests.ts calls this once per distinct tmdbId in a
   * list, and createMediaEnrichment() wraps it in a TTL cache for the watchlist
   * and issues pages.
   *
   * @throws TmdbUpstreamError on a bad status or a body with no usable id and
   * title.
   */
  async function movieDetail(id: number): Promise<MovieDetail> {
    // NOTE: external_ids is appended but nothing below reads it. Movies get
    // matched by tmdbId end to end, so unlike tvDetail there's no second id
    // system to pull out.
    const body = await getJson(`/movie/${id}`, {
      append_to_response: "external_ids",
    });

    if (typeof body !== "object" || body === null) {
      throw new TmdbUpstreamError(
        "TMDB movieDetail returned unexpected body",
        502,
      );
    }

    const row = body as {
      id?: unknown;
      title?: unknown;
      release_date?: unknown;
      overview?: unknown;
      poster_path?: unknown;
      backdrop_path?: unknown;
      runtime?: unknown;
      genres?: unknown;
      status?: unknown;
      belongs_to_collection?: unknown;
    };

    if (typeof row.id !== "number" || typeof row.title !== "string") {
      throw new TmdbUpstreamError(
        "TMDB movieDetail returned unexpected body",
        502,
      );
    }

    // Only surface a collection when both halves are usable, since the title
    // page turns this into a link and a link needs both an id and a label.
    const collection =
      typeof row.belongs_to_collection === "object" &&
      row.belongs_to_collection !== null &&
      typeof (row.belongs_to_collection as { id?: unknown }).id === "number" &&
      typeof (row.belongs_to_collection as { name?: unknown }).name === "string"
        ? {
            id: (row.belongs_to_collection as { id: number }).id,
            name: (row.belongs_to_collection as { name: string }).name,
          }
        : null;

    return {
      tmdbId: row.id,
      mediaType: "movie",
      title: row.title,
      year: yearFromDate(typeof row.release_date === "string" ? row.release_date : null),
      overview: typeof row.overview === "string" ? row.overview : "",
      posterUrl: imageUrl(row.poster_path),
      backdropUrl: imageUrl(row.backdrop_path),
      runtime: typeof row.runtime === "number" ? row.runtime : null,
      genres: mapGenreNames(row.genres),
      status: typeof row.status === "string" ? row.status : "",
      collection,
    };
  }

  /**
   * Everything the show title page needs, including the season list the
   * per-season request checkboxes are built from.
   *
   * append_to_response=external_ids earns its place here: it's the only way to
   * get the TVDB id without a second round trip, and TVDB is the id system
   * Sonarr works in.
   *
   * @throws TmdbUpstreamError on a bad status or a body with no usable id and
   * name.
   */
  async function tvDetail(id: number): Promise<TvDetail> {
    const body = await getJson(`/tv/${id}`, {
      append_to_response: "external_ids",
    });

    if (typeof body !== "object" || body === null) {
      throw new TmdbUpstreamError(
        "TMDB tvDetail returned unexpected body",
        502,
      );
    }

    const row = body as {
      id?: unknown;
      name?: unknown;
      first_air_date?: unknown;
      overview?: unknown;
      poster_path?: unknown;
      backdrop_path?: unknown;
      genres?: unknown;
      status?: unknown;
      seasons?: unknown;
      external_ids?: unknown;
    };

    if (typeof row.id !== "number" || typeof row.name !== "string") {
      throw new TmdbUpstreamError(
        "TMDB tvDetail returned unexpected body",
        502,
      );
    }

    // Optional all the way down. A show with no TVDB mapping still renders; it
    // just comes back with tvdbId null.
    const externalIds =
      typeof row.external_ids === "object" && row.external_ids !== null
        ? (row.external_ids as { tvdb_id?: unknown })
        : null;
    const tvdbRaw = externalIds?.tvdb_id;
    const tvdbId = typeof tvdbRaw === "number" ? tvdbRaw : null;

    return {
      tmdbId: row.id,
      mediaType: "tv",
      title: row.name,
      year: yearFromDate(
        typeof row.first_air_date === "string" ? row.first_air_date : null,
      ),
      overview: typeof row.overview === "string" ? row.overview : "",
      posterUrl: imageUrl(row.poster_path),
      backdropUrl: imageUrl(row.backdrop_path),
      genres: mapGenreNames(row.genres),
      status: typeof row.status === "string" ? row.status : "",
      tvdbId,
      seasons: mapTvSeasons(row.seasons),
    };
  }

  return {
    search,
    trending,
    upcoming,
    genres,
    discover,
    recommendations,
    credits,
    person,
    personCredits,
    collection,
    movieDetail,
    tvDetail,
  };
}

export type TmdbClient = ReturnType<typeof createTmdbClient>;

// Turns a TMDB image path like "/matrix.jpg" into a full w500 URL. Takes
// `unknown` because it's called straight on unvalidated fields; anything that
// isn't a non-empty string becomes null and the UI shows a placeholder.
function imageUrl(path: unknown): string | null {
  if (typeof path !== "string" || path === "") {
    return null;
  }
  return `${TMDB_IMAGE_BASE}${path}`;
}

// Pulls the year off a TMDB date string ("1999-03-31"). TMDB sends an empty
// string for undated entries, which is why the length check comes first.
function yearFromDate(date: string | null): number | null {
  if (date === null || date.length < 4) {
    return null;
  }
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : null;
}

// Flattens TMDB's [{id, name}] genre objects down to names. Nothing in the app
// needs the ids once a title is already open.
function mapGenreNames(genres: unknown): string[] {
  if (!Array.isArray(genres)) {
    return [];
  }
  const names: string[] = [];
  for (const genre of genres) {
    if (
      typeof genre === "object" &&
      genre !== null &&
      typeof (genre as { name?: unknown }).name === "string"
    ) {
      names.push((genre as { name: string }).name);
    }
  }
  return names;
}

// Season list for a show, with season 0 (TMDB's Specials bucket) filtered out.
// Requests are made per season, and specials aren't something anyone picks.
function mapTvSeasons(seasons: unknown): TvSeasonSummary[] {
  if (!Array.isArray(seasons)) {
    return [];
  }
  const mapped: TvSeasonSummary[] = [];
  for (const season of seasons) {
    if (typeof season !== "object" || season === null) {
      continue;
    }
    const seasonNumber = (season as { season_number?: unknown }).season_number;
    const name = (season as { name?: unknown }).name;
    const episodeCount = (season as { episode_count?: unknown }).episode_count;
    if (
      typeof seasonNumber !== "number" ||
      seasonNumber === 0 ||
      typeof name !== "string" ||
      typeof episodeCount !== "number"
    ) {
      continue;
    }
    mapped.push({
      seasonNumber,
      name,
      episodeCount,
    });
  }
  return mapped;
}

/**
 * Maps one TMDB result row into the card shape. Exported because the discover
 * router and several endpoints above all funnel through it.
 *
 * This is also the app's people filter. A row that resolves to neither movie
 * nor tv returns null, which is how actors get dropped out of multi-search
 * results.
 *
 * @param defaultMediaType used when the row has no media_type of its own,
 * which is the case on every single-type endpoint. A row that carries its own
 * media_type wins, even over an explicit default.
 * @returns null when the row can't be turned into a usable card, so callers
 * skip it and keep the rest of the page.
 */
export function mapMediaSummary(
  row: unknown,
  defaultMediaType?: "movie" | "tv",
): MediaSummary | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  // The row's own media_type wins. Only when it's absent does the caller's
  // default apply, and if there's still no answer the row is dropped. That's
  // what removes people from /search/multi.
  const rowMediaType = (row as { media_type?: unknown }).media_type;
  const mediaType =
    rowMediaType === undefined ? defaultMediaType : rowMediaType;
  if (mediaType !== "movie" && mediaType !== "tv") {
    return null;
  }

  const id = (row as { id?: unknown }).id;
  if (typeof id !== "number") {
    return null;
  }

  // TMDB names the same two fields differently per media type: movies get
  // title and release_date, shows get name and first_air_date.
  const title =
    mediaType === "movie"
      ? (row as { title?: unknown }).title
      : (row as { name?: unknown }).name;
  if (typeof title !== "string") {
    return null;
  }

  const dateRaw =
    mediaType === "movie"
      ? (row as { release_date?: unknown }).release_date
      : (row as { first_air_date?: unknown }).first_air_date;
  const date = typeof dateRaw === "string" ? dateRaw : null;

  const overviewRaw = (row as { overview?: unknown }).overview;
  const overview = typeof overviewRaw === "string" ? overviewRaw : "";

  return {
    tmdbId: id,
    mediaType,
    title,
    year: yearFromDate(date),
    posterUrl: imageUrl((row as { poster_path?: unknown }).poster_path),
    overview,
  };
}
