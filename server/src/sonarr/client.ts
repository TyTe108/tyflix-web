// Typed HTTP client for Sonarr, the TV library manager. Covers the episode,
// episode-file, series, and season-monitor endpoints that a future unmonitor-
// and-delete flow will need. Nothing constructs this client yet; it is ready
// to be injected the same way Seerr is once a caller exists.
//
// createSonarrClient() will run once at startup and the result will be passed
// into whichever router owns that flow. Every call authenticates with the
// Sonarr API key.
//
// Targets Sonarr API v3 (/api/v3/...). Episode-file deletes go one id at a
// time: DELETE /api/v3/episodefile/bulk returns 500 if any single id in the
// batch is stale, with no indication of what did or did not get deleted, so
// partial failure would be unattributable.
//
// Season monitoring uses GET then PUT /api/v3/series/{id}, not
// POST /api/v3/seasonpass. Live-tested: seasonpass with
// monitoringOptions {monitor:"none"} unmonitors the entire series (every
// season and every episode), ignoring the per-season flags in the payload;
// seasonpass without monitoringOptions leaves every episode in the season
// still monitored, so Sonarr re-grabs them individually. PUT /series/{id}
// with the modified series object sets the season flag and cascades to that
// season's episodes, with no collateral changes.

/**
 * Any failure talking to Sonarr, whether Sonarr answered badly or never
 * answered.
 *
 * `status` is Sonarr's own status code when there was a response, and 502 when
 * the fetch threw. Callers read it to decide what to send the browser.
 */
export class SonarrUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SonarrUpstreamError";
    this.status = status;
  }
}

export type SonarrClientOptions = {
  baseUrl: string; // no trailing slash; config strips it
  apiKey: string; // Sonarr API key, sent as X-Api-Key on every call
};

/** One episode row from GET /api/v3/episode. */
export type SonarrEpisode = {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  episodeFileId: number;
  hasFile: boolean;
  monitored: boolean;
};

/** One on-disk file row from GET /api/v3/episodefile. */
export type SonarrEpisodeFile = {
  id: number;
  seasonNumber: number;
  path: string;
  size: number;
};

/** One season entry on a series, including any extra Sonarr fields. */
export type SonarrSeason = {
  seasonNumber: number;
  monitored: boolean;
  [key: string]: unknown;
};

/**
 * A series from GET /api/v3/series/{id}. Extra Sonarr fields are preserved so
 * the PUT back to /api/v3/series/{id} can send a complete series object.
 */
export type SonarrSeries = {
  id: number;
  seasons: SonarrSeason[];
  [key: string]: unknown;
};

/**
 * Builds the Sonarr client. Intended to be created once at startup and shared
 * by whatever eventually needs episode/file/season operations.
 *
 * There's no retry and no cache in here. Callers decide how stale their data
 * is allowed to be.
 */
export function createSonarrClient(options: SonarrClientOptions) {
  const { baseUrl, apiKey } = options;

  // Single fetch chokepoint. Every Sonarr call funnels through here so the API
  // key, JSON headers and error translation are written once.
  async function requestJson(
    method: "GET" | "PUT" | "DELETE",
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "X-Api-Key": apiKey,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // Sonarr never answered (DNS, connection refused, container down). There's
      // no upstream status to forward, so call it a gateway failure.
      const message =
        err instanceof Error ? err.message : "Sonarr request failed";
      throw new SonarrUpstreamError(message, 502);
    }

    // Sonarr answered but refused. Keep its status so callers can distinguish
    // a 404 missing series from a 503 outage.
    if (!res.ok) {
      throw new SonarrUpstreamError(
        `Sonarr ${path} failed (${res.status})`,
        res.status,
      );
    }

    if (res.status === 204) {
      return null;
    }

    const text = await res.text();
    if (text.trim() === "") {
      return null;
    }
    return JSON.parse(text) as unknown;
  }

  function getJson(
    path: string,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    return requestJson("GET", path, query);
  }

  function putJson(path: string, body: unknown): Promise<unknown> {
    return requestJson("PUT", path, {}, body);
  }

  function deleteJson(path: string): Promise<unknown> {
    return requestJson("DELETE", path);
  }

  /**
   * Episodes for a series (`GET /api/v3/episode?seriesId=`).
   *
   * Rows that don't map cleanly are dropped rather than returned half-built.
   *
   * @throws SonarrUpstreamError on a bad status, a fetch failure, or a body
   * that isn't an array.
   */
  async function listEpisodes(seriesId: number): Promise<SonarrEpisode[]> {
    const body = await getJson("/api/v3/episode", {
      seriesId: String(seriesId),
    });
    if (!Array.isArray(body)) {
      throw new SonarrUpstreamError(
        "Sonarr /api/v3/episode returned unexpected body",
        502,
      );
    }

    const episodes: SonarrEpisode[] = [];
    for (const row of body) {
      const mapped = mapSonarrEpisode(row);
      if (mapped !== null) {
        episodes.push(mapped);
      }
    }
    return episodes;
  }

  /**
   * Episode files for a series (`GET /api/v3/episodefile?seriesId=`).
   *
   * Rows that don't map cleanly are dropped rather than returned half-built.
   *
   * @throws SonarrUpstreamError on a bad status, a fetch failure, or a body
   * that isn't an array.
   */
  async function listEpisodeFiles(
    seriesId: number,
  ): Promise<SonarrEpisodeFile[]> {
    const body = await getJson("/api/v3/episodefile", {
      seriesId: String(seriesId),
    });
    if (!Array.isArray(body)) {
      throw new SonarrUpstreamError(
        "Sonarr /api/v3/episodefile returned unexpected body",
        502,
      );
    }

    const files: SonarrEpisodeFile[] = [];
    for (const row of body) {
      const mapped = mapSonarrEpisodeFile(row);
      if (mapped !== null) {
        files.push(mapped);
      }
    }
    return files;
  }

  /**
   * One series by id (`GET /api/v3/series/{id}`).
   *
   * Extra Sonarr fields on the series and its seasons are preserved so a later
   * PUT can send a complete series object back. An unmappable season is a
   * hard failure: this result feeds straight into a write, and silently
   * dropping a season would PUT a series with fewer seasons than Sonarr has.
   *
   * @throws SonarrUpstreamError on a bad status, a fetch failure, an
   * unmappable body, or a seasons entry missing seasonNumber or monitored.
   */
  async function getSeries(seriesId: number): Promise<SonarrSeries> {
    const body = await getJson(`/api/v3/series/${seriesId}`);
    const mapped = mapSonarrSeries(body);
    if (mapped === null) {
      throw new SonarrUpstreamError(
        "Sonarr getSeries returned unexpected body",
        502,
      );
    }
    return mapped;
  }

  /**
   * Deletes one episode file (`DELETE /api/v3/episodefile/{id}`).
   *
   * One file per call on purpose. Sonarr's bulk delete returns 500 if any
   * single id in the batch is stale, with no indication of what did or did
   * not get deleted, so partial failure would be unattributable.
   *
   * @throws SonarrUpstreamError on a bad status or a fetch failure.
   */
  async function deleteEpisodeFile(fileId: number): Promise<void> {
    await deleteJson(`/api/v3/episodefile/${fileId}`);
  }

  /**
   * Sets the monitored flag on a list of episodes
   * (`PUT /api/v3/episode/monitor`).
   *
   * An empty `episodeIds` array is a no-op: no network call is made.
   *
   * @throws SonarrUpstreamError on a bad status or a fetch failure.
   */
  async function setEpisodesMonitored(
    episodeIds: number[],
    monitored: boolean,
  ): Promise<void> {
    if (episodeIds.length === 0) {
      return;
    }
    await putJson("/api/v3/episode/monitor", { episodeIds, monitored });
  }

  /**
   * Sets the monitored flag on named seasons of a series.
   *
   * Reads the series (`GET /api/v3/series/{id}`), flips `monitored` on exactly
   * the seasons whose numbers appear in `seasonNumbers`, leaves every other
   * season (and every non-season field) untouched, and PUTs the modified
   * series back to `/api/v3/series/{id}`.
   *
   * Avoids `/api/v3/seasonpass`: with monitoringOptions {monitor:"none"} it
   * unmonitors the entire series; without that option it does not cascade the
   * season flag to episodes. PUT /series/{id} sets the season flag and
   * cascades to that season's episodes.
   *
   * @throws SonarrUpstreamError on a bad status, a fetch failure, or an
   * unmappable series body.
   */
  async function setSeasonsMonitored(
    seriesId: number,
    seasonNumbers: number[],
    monitored: boolean,
  ): Promise<void> {
    const series = await getSeries(seriesId);
    const wanted = new Set(seasonNumbers);
    const updated: SonarrSeries = {
      ...series,
      seasons: series.seasons.map((season) =>
        wanted.has(season.seasonNumber)
          ? { ...season, monitored }
          : season,
      ),
    };
    await putJson(`/api/v3/series/${seriesId}`, updated);
  }

  return {
    listEpisodes,
    listEpisodeFiles,
    getSeries,
    deleteEpisodeFile,
    setEpisodesMonitored,
    setSeasonsMonitored,
  };
}

export type SonarrClient = ReturnType<typeof createSonarrClient>;

// Defensive parsing. Sonarr responses arrive as `unknown`. List mappers
// (episodes, episode files) return null for a bad row so callers can drop it
// and keep the rest. mapSonarrSeries returns null for the whole series when
// any season is unmappable, because that payload is round-tripped into a PUT.

function mapSonarrEpisode(row: unknown): SonarrEpisode | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const id = (row as { id?: unknown }).id;
  const seasonNumber = (row as { seasonNumber?: unknown }).seasonNumber;
  const episodeNumber = (row as { episodeNumber?: unknown }).episodeNumber;
  const title = (row as { title?: unknown }).title;
  const episodeFileId = (row as { episodeFileId?: unknown }).episodeFileId;
  const hasFile = (row as { hasFile?: unknown }).hasFile;
  const monitored = (row as { monitored?: unknown }).monitored;

  if (
    typeof id !== "number" ||
    !Number.isFinite(id) ||
    typeof seasonNumber !== "number" ||
    !Number.isFinite(seasonNumber) ||
    typeof episodeNumber !== "number" ||
    !Number.isFinite(episodeNumber) ||
    typeof title !== "string" ||
    typeof episodeFileId !== "number" ||
    !Number.isFinite(episodeFileId) ||
    typeof hasFile !== "boolean" ||
    typeof monitored !== "boolean"
  ) {
    return null;
  }

  return {
    id,
    seasonNumber,
    episodeNumber,
    title,
    episodeFileId,
    hasFile,
    monitored,
  };
}

function mapSonarrEpisodeFile(row: unknown): SonarrEpisodeFile | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const id = (row as { id?: unknown }).id;
  const seasonNumber = (row as { seasonNumber?: unknown }).seasonNumber;
  const path = (row as { path?: unknown }).path;
  const size = (row as { size?: unknown }).size;

  if (
    typeof id !== "number" ||
    !Number.isFinite(id) ||
    typeof seasonNumber !== "number" ||
    !Number.isFinite(seasonNumber) ||
    typeof path !== "string" ||
    typeof size !== "number" ||
    !Number.isFinite(size)
  ) {
    return null;
  }

  return { id, seasonNumber, path, size };
}

function mapSonarrSeason(row: unknown): SonarrSeason | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const seasonNumber = (row as { seasonNumber?: unknown }).seasonNumber;
  const monitored = (row as { monitored?: unknown }).monitored;
  if (
    typeof seasonNumber !== "number" ||
    !Number.isFinite(seasonNumber) ||
    typeof monitored !== "boolean"
  ) {
    return null;
  }

  return { ...(row as Record<string, unknown>), seasonNumber, monitored };
}

function mapSonarrSeries(row: unknown): SonarrSeries | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const id = (row as { id?: unknown }).id;
  const seasonsRaw = (row as { seasons?: unknown }).seasons;
  if (
    typeof id !== "number" ||
    !Number.isFinite(id) ||
    !Array.isArray(seasonsRaw)
  ) {
    return null;
  }

  const seasons: SonarrSeason[] = [];
  for (const season of seasonsRaw) {
    const mapped = mapSonarrSeason(season);
    if (mapped === null) {
      // Fail the whole series rather than drop a season: this object is PUT
      // back to Sonarr, and a shorter seasons array would be a silent data loss.
      return null;
    }
    seasons.push(mapped);
  }

  return { ...(row as Record<string, unknown>), id, seasons };
}
