const REQUEST_TIMEOUT_MS = 15_000;

export class SonarrUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SonarrUpstreamError";
    this.status = status;
  }
}

export type SonarrSeason = {
  seasonNumber: number;
  monitored: boolean;
};

export type SonarrSeries = {
  id?: number;
  title: string;
  tvdbId: number;
  monitored: boolean;
  seasons: SonarrSeason[];
  qualityProfileId?: number;
  languageProfileId?: number;
  seasonFolder?: boolean;
  rootFolderPath?: string;
  seriesType?: "standard" | "daily" | "anime";
  [key: string]: unknown;
};

export type AddSeriesOptions = {
  tvdbId: number;
  title: string;
  qualityProfileId: number;
  languageProfileId?: number;
  seasons: number[];
  rootFolderPath: string;
  seasonFolder?: boolean;
  monitored?: boolean;
  seriesType?: "standard" | "daily" | "anime";
  searchNow?: boolean;
};

export type SonarrClientOptions = {
  url: string;
  apiKey: string;
};

export function buildSeasonList(
  requestedNums: number[],
  lookupSeasons?: SonarrSeason[],
): SonarrSeason[] {
  if (lookupSeasons !== undefined && lookupSeasons.length > 0) {
    return lookupSeasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      monitored: requestedNums.includes(season.seasonNumber),
    }));
  }
  return requestedNums.map((seasonNumber) => ({
    seasonNumber,
    monitored: true,
  }));
}

export function createSonarrClient(options: SonarrClientOptions) {
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
        err instanceof Error ? err.message : "Sonarr request failed";
      throw new SonarrUpstreamError(message, 502);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new SonarrUpstreamError(
        `Sonarr ${path} failed (${res.status})`,
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

  async function getSeriesByTvdbId(tvdbId: number): Promise<SonarrSeries> {
    const body = await getJson("/series/lookup", {
      term: `tvdb:${tvdbId}`,
    });
    if (!Array.isArray(body) || body.length === 0) {
      throw new Error("Series not found");
    }
    return body[0] as SonarrSeries;
  }

  async function searchSeries(seriesId: number): Promise<void> {
    await runCommand("MissingEpisodeSearch", { seriesId });
  }

  async function addSeries(input: AddSeriesOptions): Promise<SonarrSeries> {
    const monitored = input.monitored ?? true;
    const searchNow = input.searchNow ?? true;
    const seasonFolder = input.seasonFolder ?? true;
    const seriesType = input.seriesType ?? "standard";
    const series = await getSeriesByTvdbId(input.tvdbId);

    if (series.id) {
      const updated = (await putJson("/series", {
        ...series,
        monitored,
        seasons: buildSeasonList(input.seasons, series.seasons),
      })) as SonarrSeries;
      return updated;
    }

    const created = (await postJson("/series", {
      tvdbId: input.tvdbId,
      title: input.title,
      qualityProfileId: input.qualityProfileId,
      languageProfileId: input.languageProfileId,
      seasons: buildSeasonList(input.seasons, series.seasons),
      seasonFolder,
      monitored,
      rootFolderPath: input.rootFolderPath,
      seriesType,
      addOptions: {
        ignoreEpisodesWithFiles: true,
        searchForMissingEpisodes: searchNow,
      },
    })) as SonarrSeries;

    return created;
  }

  return {
    getSeriesByTvdbId,
    addSeries,
    searchSeries,
  };
}

export type SonarrClient = ReturnType<typeof createSonarrClient>;
