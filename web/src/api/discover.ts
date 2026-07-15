import type { MediaAvailabilityStatus } from "./requests";

export type MediaType = "movie" | "tv";

export type Genre = {
  id: number;
  name: string;
};

export type StudioOption = {
  id: number;
  name: string;
};

export type StudiosResponse = {
  studios: StudioOption[];
  networks: StudioOption[];
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

export type PersonResponse = {
  person: PersonDetail;
  credits: MediaSummary[];
};

export type MediaSummary = {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  year: number | null;
  posterUrl: string | null;
  overview: string;
  mediaStatus: MediaAvailabilityStatus | null;
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
  mediaStatus: MediaAvailabilityStatus | null;
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
  mediaStatus: MediaAvailabilityStatus | null;
};

export type SearchResponse = {
  page: number;
  totalPages: number;
  results: MediaSummary[];
};

export type TrendingResponse = {
  results: MediaSummary[];
};

export type RecommendationsResponse = {
  results: MediaSummary[];
};

export type GenresResponse = {
  results: Genre[];
};

export type CollectionDetail = {
  id: number;
  name: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  parts: MediaSummary[];
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function fetchTrending(): Promise<MediaSummary[]> {
  const body = await getJson<TrendingResponse>("/api/discover/trending");
  return body.results;
}

export async function fetchGenres(mediaType: MediaType): Promise<Genre[]> {
  const params = new URLSearchParams({ mediaType });
  const body = await getJson<GenresResponse>(`/api/discover/genres?${params}`);
  return body.results;
}

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

export async function fetchStudios(): Promise<StudiosResponse> {
  return getJson<StudiosResponse>("/api/discover/studios");
}

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

export async function fetchMovie(id: number): Promise<MovieDetail> {
  return getJson<MovieDetail>(`/api/discover/movie/${id}`);
}

export async function fetchTv(id: number): Promise<TvDetail> {
  return getJson<TvDetail>(`/api/discover/tv/${id}`);
}

export async function fetchRecommendations(
  mediaType: MediaType,
  id: number,
): Promise<MediaSummary[]> {
  const body = await getJson<RecommendationsResponse>(
    `/api/discover/${mediaType}/${id}/recommendations`,
  );
  return body.results;
}

export async function fetchCredits(
  mediaType: MediaType,
  id: number,
): Promise<CreditsResponse> {
  return getJson<CreditsResponse>(
    `/api/discover/${mediaType}/${id}/credits`,
  );
}

export async function fetchPerson(id: number): Promise<PersonResponse> {
  return getJson<PersonResponse>(`/api/discover/person/${id}`);
}

export async function fetchCollection(id: number): Promise<CollectionDetail> {
  return getJson<CollectionDetail>(`/api/discover/collection/${id}`);
}

export function canRequest(
  mediaStatus: MediaAvailabilityStatus | null,
): boolean {
  return (
    mediaStatus !== "available" &&
    mediaStatus !== "processing" &&
    mediaStatus !== "pending"
  );
}

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
