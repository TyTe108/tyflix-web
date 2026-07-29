// Client for the server's discover router (server/src/routes/discover.ts),
// mounted at /api/discover. This is the TMDB half of the app: search, trending,
// upcoming, genre and studio browse, credits, people, collections, and the two
// title-detail endpoints behind /media/:type/:id.
//
// Every media-shaped row that comes back from here already carries
// `mediaStatus`, which is Seerr's answer to "is this on the Plex server yet".
// The server does that join before responding, which is why a poster can be
// marked green or amber without a request per card. A null mediaStatus is the
// normal case for a title nobody has ever asked for.
//
// ---- Conventions every file in api/ follows ----
//
// URLs are relative, so requests go back to the same origin that served the
// SPA. The httpOnly tyflix_session cookie rides along on its own and nothing in
// api/ ever sets an Authorization header, because the browser has no Plex token
// to send. In development Vite proxies /api through to the Node server on 4000.
//
// Failures throw. Every wrapper turns a non-2xx into `new Error(...)` and the
// calling page catches it and renders err.message. There's no fetch
// interceptor and no global 401 handler, so a 401 out of any of these reads as
// an ordinary failure. api/auth.ts is the one exception: fetchMe treats 401 as
// a value meaning "logged out", and AuthContext is what turns that into the
// redirect. Where a page needs to tell specific failures apart, the client
// returns a discriminated result instead of throwing. createRequest in
// api/requests.ts and submitAccessRequest in api/accessRequests.ts both do that.
//
// The server answers upstream trouble with 502 and a JSON `{ error }` body.
// Only some clients bother reading that body back out. This one doesn't, so a
// TMDB outage surfaces to the user as a bare "Request failed (502)".

import type { MediaAvailabilityStatus } from "./requests";

export type MediaType = "movie" | "tv";

// A TMDB genre. Movie and TV genre ids are separate namespaces upstream, which
// is why fetchGenres insists on a mediaType.
export type Genre = {
  id: number;
  name: string;
};

// One tile on the studio or network picker. `id` goes back to /browse as
// companyId (studios) or networkId (networks).
export type StudioOption = {
  id: number;
  name: string;
};

// GET /studios. Both lists are hardcoded server-side in tmdb/studios.ts, so
// this call never actually reaches TMDB.
export type StudiosResponse = {
  studios: StudioOption[];
  networks: StudioOption[];
};

// Cast and crew rows share an `id` that's a TMDB person id, so both link
// straight to /person/:id. profileUrl is null when TMDB has no headshot.
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

// GET /:mediaType/:id/credits. Not annotated with availability, since people
// aren't media.
export type CreditsResponse = {
  cast: CastCredit[];
  crew: CrewCredit[];
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

// GET /person/:id. The profile plus everything they've been in, with the
// credits carrying availability so the page can badge what's already here.
export type PersonResponse = {
  person: PersonDetail;
  credits: MediaSummary[];
};

// The poster-grid row. Everything that renders a MediaCard uses this shape,
// whether it came from search, trending, a collection or a person's credits.
export type MediaSummary = {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  year: number | null;
  posterUrl: string | null;
  overview: string;
  mediaStatus: MediaAvailabilityStatus | null; // null when Seerr has no record
};

// GET /movie/:id, the movie title page. `mediaStatus` is what decides whether
// the page offers Play or Request.
export type MovieDetail = {
  tmdbId: number;
  mediaType: "movie";
  title: string;
  year: number | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  runtime: number | null; // minutes, straight from TMDB
  genres: string[];
  status: string;
  collection: {
    id: number;
    name: string;
  } | null;
  mediaStatus: MediaAvailabilityStatus | null;
};

// One season on a show's title page. seasonNumber 0 is specials.
export type TvSeasonSummary = {
  seasonNumber: number;
  name: string;
  episodeCount: number;
};

// GET /tv/:id, the TV twin of MovieDetail. The season list drives the
// per-season request checkboxes.
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
  mediaStatus: MediaAvailabilityStatus | null;
};

// TMDB's paged envelope, passed through by /search and /browse. Page numbers
// are 1-based.
export type SearchResponse = {
  page: number;
  totalPages: number;
  results: MediaSummary[];
};

// The unpaged `{ results }` envelope the rail endpoints use.
export type TrendingResponse = {
  results: MediaSummary[];
};

export type RecommendationsResponse = {
  results: MediaSummary[];
};

export type GenresResponse = {
  results: Genre[];
};

// GET /collection/:id. `parts` is annotated, so a trilogy page can show which
// two films are already on the server.
export type CollectionDetail = {
  id: number;
  name: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  parts: MediaSummary[];
};

// Every call in this file goes through here. Status code only: the server's
// `{ error }` body is discarded, so the thrown message is always the bare
// status. api/library.ts has an identical private copy.
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/**
 * GET /api/discover/trending. What TMDB says is trending globally, annotated
 * with Plex availability. This is the Discover page's default rail.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchTrending(): Promise<MediaSummary[]> {
  const body = await getJson<TrendingResponse>("/api/discover/trending");
  return body.results;
}

/**
 * GET /api/discover/upcoming. Titles TMDB has scheduled but not released.
 *
 * Availability is best-effort on this one: if Seerr hiccups the server still
 * returns 200 with every row's mediaStatus null, rather than failing.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchUpcoming(
  mediaType: MediaType,
): Promise<MediaSummary[]> {
  const params = new URLSearchParams({ mediaType });
  const body = await getJson<TrendingResponse>(
    `/api/discover/upcoming?${params}`,
  );
  return body.results;
}

/**
 * GET /api/discover/genres. The genre options for the browse filter.
 *
 * Movie and TV genres are different id sets upstream, so a list fetched for one
 * media type can't be reused for the other.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchGenres(mediaType: MediaType): Promise<Genre[]> {
  const params = new URLSearchParams({ mediaType });
  const body = await getJson<GenresResponse>(`/api/discover/genres?${params}`);
  return body.results;
}

/**
 * GET /api/discover/browse. The filtered discovery grid behind the genre,
 * studio and network pages.
 *
 * companyId only means anything for movies and networkId only for TV. Passing
 * the wrong one isn't an error, the server just drops it. Omitted options are
 * left out of the query string entirely rather than sent empty.
 *
 * @throws Error on any non-2xx, including the 400 the server returns for a
 * non-numeric filter id.
 */
export async function browseMedia(
  mediaType: MediaType,
  options: {
    genreId?: number;
    companyId?: number;
    networkId?: number;
    page?: number;
  } = {},
): Promise<SearchResponse> {
  const params = new URLSearchParams({ mediaType });
  if (options.genreId !== undefined) {
    params.set("genreId", String(options.genreId));
  }
  if (options.companyId !== undefined) {
    params.set("companyId", String(options.companyId));
  }
  if (options.networkId !== undefined) {
    params.set("networkId", String(options.networkId));
  }
  if (options.page !== undefined) {
    params.set("page", String(options.page));
  }
  return getJson<SearchResponse>(`/api/discover/browse?${params}`);
}

/**
 * GET /api/discover/studios. The curated studio and network tiles.
 *
 * Hardcoded on the server, so this can't really fail for upstream reasons.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchStudios(): Promise<StudiosResponse> {
  return getJson<StudiosResponse>("/api/discover/studios");
}

/**
 * GET /api/discover/search. TMDB multi-search, annotated with availability.
 *
 * The server rejects a blank or whitespace-only query with a 400, so callers
 * should skip the call rather than send an empty search box.
 *
 * @throws Error on any non-2xx.
 */
export async function searchMedia(
  query: string,
  page = 1,
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    query,
    page: String(page),
  });
  return getJson<SearchResponse>(`/api/discover/search?${params}`);
}

/**
 * GET /api/discover/movie/:id. Everything the movie title page renders.
 *
 * @throws Error on any non-2xx. TMDB not knowing the id comes back as a 502
 * rather than a 404, because the server doesn't forward TMDB's status.
 */
export async function fetchMovie(id: number): Promise<MovieDetail> {
  return getJson<MovieDetail>(`/api/discover/movie/${id}`);
}

/**
 * GET /api/discover/tv/:id. The show version of fetchMovie, same error
 * behavior.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchTv(id: number): Promise<TvDetail> {
  return getJson<TvDetail>(`/api/discover/tv/${id}`);
}

/**
 * GET /api/discover/:mediaType/:id/recommendations. TMDB's "more like this",
 * annotated so the rail can badge what's already on the server.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchRecommendations(
  mediaType: MediaType,
  id: number,
): Promise<MediaSummary[]> {
  const body = await getJson<RecommendationsResponse>(
    `/api/discover/${mediaType}/${id}/recommendations`,
  );
  return body.results;
}

/**
 * GET /api/discover/:mediaType/:id/credits. Cast and crew for a title, passed
 * through from TMDB untouched.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchCredits(
  mediaType: MediaType,
  id: number,
): Promise<CreditsResponse> {
  return getJson<CreditsResponse>(
    `/api/discover/${mediaType}/${id}/credits`,
  );
}

/**
 * GET /api/discover/person/:id. One person plus their annotated credits, which
 * is the whole payload for /person/:id.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchPerson(id: number): Promise<PersonResponse> {
  return getJson<PersonResponse>(`/api/discover/person/${id}`);
}

/**
 * GET /api/discover/collection/:id. A TMDB collection with its films.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchCollection(id: number): Promise<CollectionDetail> {
  return getJson<CollectionDetail>(`/api/discover/collection/${id}`);
}

/**
 * Whether the Request button should be offered for a title.
 *
 * Requesting is blocked once the pipeline already has it in hand: available,
 * processing, or pending. Everything else is fair game, and that includes a few
 * cases worth calling out. `partially_available` stays requestable so you can
 * ask for the seasons that are missing. So does null, which just means Seerr
 * has never heard of the title.
 *
 * MediaDetailPage is the caller. See lib/requestControls.ts for the separate
 * question of filtering a list of requests you've already made.
 */
export function canRequest(
  mediaStatus: MediaAvailabilityStatus | null,
): boolean {
  return (
    mediaStatus !== "available" &&
    mediaStatus !== "processing" &&
    mediaStatus !== "pending"
  );
}

/**
 * CSS classes for the availability corner badge on a poster.
 *
 * The palette is reused from the request-status badges rather than given its
 * own, so `partially_available` borrows the amber "pending" class and the dead
 * states (unknown, deleted) borrow "declined". A null status returns an empty
 * string, which is how a card with nothing to say renders no badge at all.
 */
export function mediaStatusBadgeClass(
  mediaStatus: MediaAvailabilityStatus | null,
): string {
  switch (mediaStatus) {
    case null:
      return "";
    case "available":
      return "request-status request-status-approved";
    case "partially_available":
      return "request-status request-status-pending";
    case "processing":
    case "pending":
      return "request-status request-status-processing";
    case "blocklisted":
      return "request-status request-status-failed";
    case "unknown":
    case "deleted":
      return "request-status request-status-declined";
  }
}

/**
 * Renders a TMDB runtime in minutes as "2h 14m", dropping whichever half is
 * zero so you get "45m" or "2h" instead of "0h 45m".
 */
export function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) {
    return `${m}m`;
  }
  if (m === 0) {
    return `${h}h`;
  }
  return `${h}h ${m}m`;
}
