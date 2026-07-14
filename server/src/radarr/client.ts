const REQUEST_TIMEOUT_MS = 15_000;

export class RadarrUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RadarrUpstreamError";
    this.status = status;
  }
}

export type RadarrMovie = {
  id?: number;
  title: string;
  tmdbId: number;
  year?: number;
  hasFile: boolean;
  monitored: boolean;
  qualityProfileId?: number;
  rootFolderPath?: string;
  minimumAvailability?: string;
  titleSlug?: string;
  tags?: number[];
  [key: string]: unknown;
};

export type AddMovieOptions = {
  tmdbId: number;
  title: string;
  year: number;
  qualityProfileId: number;
  rootFolderPath: string;
  minimumAvailability: string;
  monitored?: boolean;
  searchNow?: boolean;
};

export type RadarrClientOptions = {
  url: string;
  apiKey: string;
};

export function createRadarrClient(options: RadarrClientOptions) {
  const baseUrl = `${options.url.replace(/\/+$/, "")}/api/v3`;
  const { apiKey } = options;

  async function request(
    method: "GET" | "POST" | "PUT",
    path: string,
    init?: { query?: Record<string, string>; body?: unknown },
  ): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);
    if (init?.query) {
      for (const [key, value] of Object.entries(init.query)) {
        url.searchParams.set(key, value);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "X-Api-Key": apiKey,
          Accept: "application/json",
          ...(init?.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Radarr request failed";
      throw new RadarrUpstreamError(message, 502);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new RadarrUpstreamError(
        `Radarr ${path} failed (${res.status})`,
        res.status,
      );
    }

    if (res.status === 204) {
      return null;
    }
    return res.json();
  }

  function getJson(
    path: string,
    query?: Record<string, string>,
  ): Promise<unknown> {
    return request("GET", path, { query });
  }

  function postJson(path: string, body: unknown): Promise<unknown> {
    return request("POST", path, { body });
  }

  function putJson(path: string, body: unknown): Promise<unknown> {
    return request("PUT", path, { body });
  }

  async function runCommand(
    name: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await postJson("/command", { name, ...body });
  }

  async function getMovieByTmdbId(tmdbId: number): Promise<RadarrMovie> {
    const body = await getJson("/movie/lookup", {
      term: `tmdb:${tmdbId}`,
    });
    if (!Array.isArray(body) || body.length === 0) {
      throw new Error("Movie not found");
    }
    return body[0] as RadarrMovie;
  }

  async function searchMovie(movieId: number): Promise<void> {
    await runCommand("MoviesSearch", { movieIds: [movieId] });
  }

  async function addMovie(input: AddMovieOptions): Promise<RadarrMovie> {
    const monitored = input.monitored ?? true;
    const searchNow = input.searchNow ?? true;
    const movie = await getMovieByTmdbId(input.tmdbId);

    if (movie.hasFile) {
      return movie;
    }

    if (movie.id && !movie.monitored) {
      const updated = (await putJson("/movie", {
        ...movie,
        title: input.title,
        qualityProfileId: input.qualityProfileId,
        minimumAvailability: input.minimumAvailability,
        tmdbId: input.tmdbId,
        year: input.year,
        rootFolderPath: input.rootFolderPath,
        monitored,
        addOptions: {
          searchForMovie: searchNow,
        },
      })) as RadarrMovie;

      if (searchNow && updated.id !== undefined) {
        await searchMovie(updated.id);
      }
      return updated;
    }

    if (movie.id) {
      if (searchNow && !movie.hasFile) {
        await searchMovie(movie.id);
      }
      return movie;
    }

    const created = (await postJson("/movie", {
      title: input.title,
      qualityProfileId: input.qualityProfileId,
      titleSlug: String(input.tmdbId),
      minimumAvailability: input.minimumAvailability,
      tmdbId: input.tmdbId,
      year: input.year,
      rootFolderPath: input.rootFolderPath,
      monitored,
      tags: [],
      addOptions: {
        searchForMovie: searchNow,
      },
    })) as RadarrMovie;

    return created;
  }

  return {
    getMovieByTmdbId,
    addMovie,
    searchMovie,
  };
}

export type RadarrClient = ReturnType<typeof createRadarrClient>;
