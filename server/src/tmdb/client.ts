const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";

export type MediaSummary = {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  year: number | null;
  posterUrl: string | null;
  overview: string;
};

export type MovieDetail = {
  tmdbId: number;
  mediaType: "movie";
  title: string;
  year: number | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  runtime: number | null;
  genres: string[];
  status: string;
  collection: {
    id: number;
    name: string;
  } | null;
};

export type TvSeasonSummary = {
  seasonNumber: number;
  name: string;
  episodeCount: number;
};

export type TvDetail = {
  tmdbId: number;
  mediaType: "tv";
  title: string;
  year: number | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  genres: string[];
  status: string;
  tvdbId: number | null;
  seasons: TvSeasonSummary[];
};

export type SearchResult = {
  page: number;
  totalPages: number;
  results: MediaSummary[];
};

export type Genre = {
  id: number;
  name: string;
};

export type CastCredit = {
  id: number;
  name: string;
  character: string;
  profileUrl: string | null;
};

export type CrewCredit = {
  id: number;
  name: string;
  job: string;
  profileUrl: string | null;
};

export type PersonDetail = {
  id: number;
  name: string;
  biography: string;
  profileUrl: string | null;
  knownForDepartment: string;
  birthday: string | null;
  placeOfBirth: string | null;
};

export type CollectionDetail = {
  id: number;
  name: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  parts: MediaSummary[];
};

export type DiscoverOptions = {
  genreId?: number;
  companyId?: number;
  networkId?: number;
  page?: number;
};

export class TmdbUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TmdbUpstreamError";
    this.status = status;
  }
}

export type TmdbClientOptions = {
  apiKey: string;
};

export function createTmdbClient(options: TmdbClientOptions) {
  const { apiKey } = options;

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
      const message =
        err instanceof Error ? err.message : "TMDB request failed";
      throw new TmdbUpstreamError(message, 502);
    }

    if (!res.ok) {
      throw new TmdbUpstreamError(
        `TMDB ${path} failed (${res.status})`,
        res.status,
      );
    }

    return res.json();
  }

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

  async function recommendations(
    mediaType: "movie" | "tv",
    id: number,
  ): Promise<MediaSummary[]> {
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

    const keyJobs = new Set([
      "Director",
      "Creator",
      "Screenplay",
      "Writer",
      "Executive Producer",
      "Producer",
    ]);
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

  async function movieDetail(id: number): Promise<MovieDetail> {
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

function imageUrl(path: unknown): string | null {
  if (typeof path !== "string" || path === "") {
    return null;
  }
  return `${TMDB_IMAGE_BASE}${path}`;
}

function yearFromDate(date: string | null): number | null {
  if (date === null || date.length < 4) {
    return null;
  }
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : null;
}

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

export function mapMediaSummary(
  row: unknown,
  defaultMediaType?: "movie" | "tv",
): MediaSummary | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

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
