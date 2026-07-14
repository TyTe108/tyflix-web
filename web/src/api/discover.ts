export type MediaType = "movie" | "tv";

export type MediaSummary = {
  tmdbId: number;
  mediaType: MediaType;
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

export type SearchResponse = {
  page: number;
  totalPages: number;
  results: MediaSummary[];
};

export type TrendingResponse = {
  results: MediaSummary[];
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
