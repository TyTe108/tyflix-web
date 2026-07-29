// Client for the server's library router (server/src/routes/library.ts),
// mounted at /api/library behind requireAuth. This is what's actually on the
// Plex server, as opposed to api/discover.ts, which browses TMDB.
//
// Two things separate this from discovery. Sorting, genre filtering, the A-Z
// rail and title search all run on Plex's side, not in the browser, because the
// page only ever holds one slice of a section and filtering here would filter
// that slice. And the rows carry per-user watch state, which works because the
// server decrypts the caller's own Plex token and resolves their per-server
// token before asking Plex. A shared user's plex.tv token is not the token this
// PMS accepts, and getting that wrong once broke every shared account.
//
// Errors follow the api/discover.ts convention. getJson below is an identical
// private copy of the one in that file, status code only.

// A top-level Plex section. `key` is what every /sections/:key route takes.
export type LibrarySection = {
  key: string;
  title: string;
  type: "movie" | "show";
};

// A row in the library grid. The last three fields are this user's watch state,
// and all three come back null when the session has no stored Plex token,
// rather than falling back to the owner's progress. tmdbId is null for anything
// Plex couldn't match, which is what libraryItemTarget has to work around.
export type LibraryItem = {
  ratingKey: string;
  type: string;
  title: string;
  year: number | null;
  thumb: string | null; // a Plex path, not a URL; run it through libraryImageUrl
  addedAt: number | null; // epoch seconds
  tmdbId: number | null;
  summary: string | null;
  rating: number | null;
  contentRating: string | null;
  runtime: number | null; // minutes
  durationMs: number | null; // milliseconds, pairs with viewOffset
  genres: string[];
  viewOffset: number | null; // ms into the item, drives the progress bar
  viewCount: number | null; // times finished; > 0 is the watched badge
  lastViewedAt: number | null; // epoch seconds
};

// The grid response echoes back every filter the server actually applied, not
// just the items. That's what lets the page trust the response over its own
// pending state when several filter changes race.
export type LibraryItemsResponse = {
  items: LibraryItem[];
  totalSize: number; // total matching the filters, not the page length
  start: number;
  size: number;
  sort: string;
  genre: string | null;
  unwatched: boolean;
  firstCharacter: string | null;
  query: string | null;
};

// The sort values the server accepts. Anything else is a 400, not a silent
// fallback to title.
export type LibrarySortKey = "title" | "added" | "year" | "rating";

// A genre filter option. `id` is a numeric Plex genre id in string form and
// goes straight back as the `genre` param.
export type LibraryGenre = {
  id: string;
  title: string;
};

// One stop on the A-Z rail. Only letters that actually have titles come back,
// plus a "#" bucket, so the rail never offers a dead jump.
export type LibraryFirstCharacter = {
  label: string;
  count: number;
};

// Status code only, same as the copy in api/discover.ts. The server's `{ error }`
// body is discarded.
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/**
 * GET /api/library/sections. The server's movie and show sections.
 *
 * Read with the server token rather than the caller's, since the section list
 * is the same for everybody.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchSections(): Promise<LibrarySection[]> {
  const body = await getJson<{ sections: LibrarySection[] }>(
    "/api/library/sections",
  );
  return body.sections;
}

/**
 * GET /api/library/sections/:key/items. The main library grid.
 *
 * `sort` defaults to title here rather than being left off, so the caller and
 * the server always agree on the ordering. The rest are only sent when set, and
 * `unwatched` is only sent when true, because the server treats a present but
 * unrecognised value as a 400 instead of quietly ignoring it.
 *
 * Server-side caps worth knowing: `size` has to be 1-100 and `query` has to be
 * 100 characters or fewer. A whitespace-only query is treated as no filter.
 *
 * @throws Error on any non-2xx, and the 400s name whichever param was wrong.
 */
export async function fetchLibraryItems(options: {
  sectionKey: string;
  sort?: string;
  start?: number;
  size?: number;
  genre?: string;
  unwatched?: boolean;
  firstCharacter?: string;
  query?: string;
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
  if (options.firstCharacter !== undefined) {
    params.set("firstCharacter", options.firstCharacter);
  }
  if (options.query !== undefined) {
    params.set("query", options.query);
  }
  return getJson<LibraryItemsResponse>(
    `/api/library/sections/${options.sectionKey}/items?${params}`,
  );
}

/**
 * GET /api/library/sections/:key/genres. Genres that actually appear in this
 * section, for the filter dropdown.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchSectionGenres(
  sectionKey: string,
): Promise<LibraryGenre[]> {
  const body = await getJson<{ genres: LibraryGenre[] }>(
    `/api/library/sections/${sectionKey}/genres`,
  );
  return body.genres;
}

/**
 * GET /api/library/sections/:key/first-characters. Backs the A-Z rail. Feed a
 * returned label straight back as `firstCharacter` on fetchLibraryItems.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchSectionFirstCharacters(
  sectionKey: string,
): Promise<LibraryFirstCharacter[]> {
  const body = await getJson<{ characters: LibraryFirstCharacter[] }>(
    `/api/library/sections/${sectionKey}/first-characters`,
  );
  return body.characters;
}

/**
 * Turns a Plex thumb path into a URL the browser can put in an `<img>`.
 *
 * Artwork is proxied back through this origin so the page never has to know the
 * Plex address or hold its token. The server only accepts paths matching
 * /library/metadata/<id>/(thumb|art)/<id>, since anything looser would make it
 * an open proxy for the whole PMS API.
 */
export function libraryImageUrl(thumbPath: string): string {
  return `/api/library/image?path=${encodeURIComponent(thumbPath)}`;
}

/**
 * Where clicking a library card should go, or null when there's nowhere useful.
 *
 * Three cases, and the middle one is the reason this function exists. With a
 * TMDB id you get the full title page. Without one, a movie still has to be
 * playable, so it goes straight to /watch/item/:ratingKey and skips the title
 * page entirely. A show with no TMDB id has no episode list to offer, so it
 * returns null and the card renders unclickable.
 */
export function libraryItemTarget(item: LibraryItem): string | null {
  if (item.tmdbId !== null) {
    const mediaType = item.type === "show" ? "tv" : "movie";
    return `/media/${mediaType}/${item.tmdbId}`;
  }
  if (item.type !== "show") {
    return `/watch/item/${item.ratingKey}`;
  }
  return null;
}
