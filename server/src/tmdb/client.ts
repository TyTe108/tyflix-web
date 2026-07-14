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
    };

    if (typeof row.id !== "number" || typeof row.title !== "string") {
      throw new TmdbUpstreamError(
        "TMDB movieDetail returned unexpected body",
        502,
      );
    }

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

  return { search, trending, movieDetail, tvDetail };
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

function mapMediaSummary(row: unknown): MediaSummary | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const mediaType = (row as { media_type?: unknown }).media_type;
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
