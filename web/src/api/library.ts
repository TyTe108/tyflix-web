export type LibrarySection = {
  key: string;
  title: string;
  type: "movie" | "show";
};

export type LibraryItem = {
  ratingKey: string;
  type: string;
  title: string;
  year: number | null;
  thumb: string | null;
  addedAt: number | null;
  tmdbId: number | null;
};

export type LibraryItemsResponse = {
  items: LibraryItem[];
  totalSize: number;
  start: number;
  size: number;
  sort: string;
  genre: string | null;
  unwatched: boolean;
};

export type LibrarySortKey = "title" | "added" | "year" | "rating";

export type LibraryGenre = {
  id: string;
  title: string;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function fetchSections(): Promise<LibrarySection[]> {
  const body = await getJson<{ sections: LibrarySection[] }>(
    "/api/library/sections",
  );
  return body.sections;
}

export async function fetchLibraryItems(options: {
  sectionKey: string;
  sort?: string;
  start?: number;
  size?: number;
  genre?: string;
  unwatched?: boolean;
}): Promise<LibraryItemsResponse> {
  const params = new URLSearchParams();
  params.set("sort", options.sort ?? "title");
  if (options.start !== undefined) {
    params.set("start", String(options.start));
  }
  if (options.size !== undefined) {
    params.set("size", String(options.size));
  }
  if (options.genre !== undefined) {
    params.set("genre", options.genre);
  }
  if (options.unwatched === true) {
    params.set("unwatched", "1");
  }
  return getJson<LibraryItemsResponse>(
    `/api/library/sections/${options.sectionKey}/items?${params}`,
  );
}

export async function fetchSectionGenres(
  sectionKey: string,
): Promise<LibraryGenre[]> {
  const body = await getJson<{ genres: LibraryGenre[] }>(
    `/api/library/sections/${sectionKey}/genres`,
  );
  return body.genres;
}

export function libraryImageUrl(thumbPath: string): string {
  return `/api/library/image?path=${encodeURIComponent(thumbPath)}`;
}
