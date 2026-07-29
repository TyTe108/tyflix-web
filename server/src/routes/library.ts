// Browsing what's actually on the Plex server, as opposed to discovery, which
// browses TMDB. Mounted at /api/library behind requireAuth. Five endpoints:
//
//   GET /image?path=...                   artwork proxy
//   GET /sections                         the Movies / TV Shows sections
//   GET /sections/:key/items              the paged, filtered, sorted grid
//   GET /sections/:key/genres             genre filter options
//   GET /sections/:key/first-characters   the A-Z rail
//
// Plex is the only upstream, though /sections/:key/items also reaches plex.tv
// indirectly to resolve the caller's per-server token. That token is the whole
// reason this router cares about the session: sending Plex the right one is
// what makes viewOffset and viewCount reflect the person browsing rather than
// the server owner.
//
// Sorting, genre filtering and title search all run on Plex's side. The browser
// only ever holds one page, so filtering here would only filter that page.

import { Router } from "express";
import { resolvePmsToken } from "../plex/resolvePmsToken";
import type { SharedServerAccessResolver } from "../plex/sharedServerAccess";
import {
  PlexServerUpstreamError,
  type LibrarySortKey,
  type PlexServerClient,
} from "../plex/server";
import { readPlexToken, type SessionPayload } from "../session";

// Accepted `sort` values. plex/server.ts maps each one to Plex's own sort
// string; anything else is a 400 rather than a silent fallback.
const LIBRARY_SORT_KEYS = new Set<LibrarySortKey>([
  "title",
  "added",
  "year",
  "rating",
]);

// The only shape /image will fetch. This is an allowlist, not a sanity check:
// the path goes straight to Plex with the server token attached, so a looser
// pattern would turn this route into an open proxy for the whole PMS API.
const LIBRARY_IMAGE_PATH_RE =
  /^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/;

export type LibraryRouterDeps = {
  plexServer: PlexServerClient;
  sharedServerAccess: SharedServerAccessResolver;
  sessionSecret: string;
};

export function createLibraryRouter(deps: LibraryRouterDeps): Router {
  const { plexServer, sharedServerAccess, sessionSecret } = deps;
  const router = Router();

  /**
   * GET /api/library/image?path=/library/metadata/<id>/(thumb|art)/<id>
   *
   * Streams Plex artwork back through this origin, so posters load without the
   * browser ever seeing the Plex token or the server's address. Responds with
   * the image bytes, Plex's content type (defaulting to image/jpeg) and a
   * one-day Cache-Control.
   *
   * 400 when `path` is missing or doesn't match the allowlist, 502 when Plex
   * refuses the fetch or throws.
   */
  router.get("/image", async (req, res) => {
    const path = req.query.path;
    if (typeof path !== "string") {
      res.status(400).json({ error: "path is required" });
      return;
    }
    if (!LIBRARY_IMAGE_PATH_RE.test(path)) {
      res.status(400).json({ error: "invalid image path" });
      return;
    }

    try {
      const result = await plexServer.fetchImage(path);
      if (!result.ok) {
        res.status(502).json({ error: "image fetch failed" });
        return;
      }
      res.set("Content-Type", result.contentType ?? "image/jpeg");
      res.set("Cache-Control", "public, max-age=86400");
      res.send(result.body);
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/library/sections
   *
   * The server's movie and show sections, `{ sections }`. The `key` on each one
   * is what the three /sections/:key routes below take. Reads the server token,
   * not the caller's, since the section list is the same for everybody.
   * 502 if Plex fails.
   */
  router.get("/sections", async (_req, res) => {
    try {
      const sections = await plexServer.sections();
      res.json({ sections });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/library/sections/:key/items
   *
   * The main library grid. Query params, all optional except where noted:
   * `sort` (title|added|year|rating, default title), `start` (default 0),
   * `size` (1-100, default 50), `genre` (numeric Plex genre id), `unwatched`
   * ("1" or "true"), `firstCharacter` (one of A-Z, 0-9 or #) and `query` (title
   * substring, up to 100 chars).
   *
   * Returns `{ items, totalSize }` plus an echo of every filter that was
   * applied, which is what lets the UI trust the response over its own pending
   * state. 400 names the first bad param, 401 without a session, 502 if Plex
   * fails.
   *
   * Every item carries `viewOffset`, `viewCount` and `lastViewedAt` for the
   * caller. On a session with no stored Plex token those three come back null
   * rather than showing the owner's progress to someone else.
   */
  router.get("/sections/:key/items", async (req, res) => {
    const sectionKey = req.params.key;
    if (!/^\d+$/.test(sectionKey)) {
      res.status(400).json({ error: "invalid section key" });
      return;
    }

    // Validate every filter up front and bail on the first bad one, so nothing
    // half-parsed reaches Plex.
    const sortRaw =
      typeof req.query.sort === "string" ? req.query.sort : "title";
    if (!isLibrarySortKey(sortRaw)) {
      res.status(400).json({ error: "invalid sort" });
      return;
    }
    const sort = sortRaw;

    const start = parseBoundedIntQuery(req.query.start, { min: 0 });
    if (start === null) {
      res.status(400).json({ error: "invalid start" });
      return;
    }

    const size = parseBoundedIntQuery(req.query.size, { min: 1, max: 100 });
    if (size === null) {
      res.status(400).json({ error: "invalid size" });
      return;
    }

    const genreResult = parseOptionalNumericQuery(req.query.genre);
    if (genreResult === null) {
      res.status(400).json({ error: "invalid genre" });
      return;
    }

    const unwatchedResult = parseUnwatchedQuery(req.query.unwatched);
    if (unwatchedResult === null) {
      res.status(400).json({ error: "invalid unwatched" });
      return;
    }

    const firstCharacterResult = parseFirstCharacterQuery(
      req.query.firstCharacter,
    );
    if (firstCharacterResult === null) {
      res.status(400).json({ error: "invalid firstCharacter" });
      return;
    }

    const queryResult = parseTitleQuery(req.query.query);
    if (queryResult === null) {
      res.status(400).json({ error: "invalid query" });
      return;
    }

    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    // Decrypt the caller's Plex token out of the session cookie. A null means
    // the session predates token capture, which is legitimate; a throw means
    // the blob is corrupt or tampered with, and that surfaces as a 502.
    let durableToken: string | null;
    try {
      durableToken = readPlexToken(session, sessionSecret);
    } catch (err) {
      respondUpstreamError(res, err);
      return;
    }

    // Shared users need their per-server token, not their plex.tv account
    // token, or the PMS rejects them. This call sits outside the try below, so
    // a plex.tv failure here answers 500 rather than the 502 the wrapped calls
    // give: express 5 forwards a rejected async handler to next(error) and the
    // default handler takes it from there.
    let userToken: string | undefined;
    if (durableToken !== null) {
      userToken = await resolvePmsToken(
        sharedServerAccess,
        session.plexId,
        durableToken,
      );
    }

    try {
      const result = await plexServer.sectionItems({
        sectionKey,
        sort,
        start: start ?? 0,
        size: size ?? 50,
        ...(genreResult !== undefined ? { genre: genreResult } : {}),
        ...(unwatchedResult ? { unwatched: true } : {}),
        ...(firstCharacterResult !== undefined
          ? { firstCharacter: firstCharacterResult }
          : {}),
        ...(queryResult !== undefined ? { title: queryResult } : {}),
        ...(userToken !== undefined ? { userToken } : {}),
      });
      // Without a user token the progress fields Plex returned belong to the
      // server owner, so blank them instead of showing one person's watch state
      // to another.
      const items =
        userToken === undefined
          ? result.items.map((item) => ({
              ...item,
              viewOffset: null,
              viewCount: null,
              lastViewedAt: null,
            }))
          : result.items;
      res.json({
        items,
        totalSize: result.totalSize,
        start: start ?? 0,
        size: size ?? 50,
        sort,
        genre: genreResult ?? null,
        unwatched: unwatchedResult,
        firstCharacter: firstCharacterResult ?? null,
        query: queryResult ?? null,
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/library/sections/:key/genres
   *
   * Genres present in this section, `{ genres }`, for the filter dropdown. Each
   * carries the numeric id the items route wants in `genre`. 400 for a
   * non-numeric section key, 502 if Plex fails.
   */
  router.get("/sections/:key/genres", async (req, res) => {
    const sectionKey = req.params.key;
    if (!/^\d+$/.test(sectionKey)) {
      res.status(400).json({ error: "invalid section key" });
      return;
    }

    try {
      const genres = await plexServer.sectionGenres(sectionKey);
      res.json({ genres });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/library/sections/:key/first-characters
   *
   * Backs the A-Z rail: `{ characters }`, one `{ label, count }` per starting
   * letter that actually has titles under it, including the "#" bucket. Feed a
   * label back as `firstCharacter` on the items route. 400 for a non-numeric
   * section key, 502 if Plex fails.
   */
  router.get("/sections/:key/first-characters", async (req, res) => {
    const sectionKey = req.params.key;
    if (!/^\d+$/.test(sectionKey)) {
      res.status(400).json({ error: "invalid section key" });
      return;
    }

    try {
      const characters = await plexServer.sectionFirstCharacters(sectionKey);
      res.json({ characters });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  return router;
}

function isLibrarySortKey(value: string): value is LibrarySortKey {
  return LIBRARY_SORT_KEYS.has(value as LibrarySortKey);
}

// The parse helpers below share one convention: undefined means the param
// wasn't sent (use the default), null means it was sent and is invalid (400).
// Keeping those two apart is why they don't just return a number.

// Digits only, then range-checked. Used for start and size.
function parseBoundedIntQuery(
  raw: unknown,
  bounds: { min: number; max?: number },
): number | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (value < bounds.min) {
    return null;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    return null;
  }
  return value;
}

// Genre ids stay strings because that's how they go back out to Plex; this only
// checks they're numeric.
function parseOptionalNumericQuery(raw: unknown): string | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return null;
  }
  return raw;
}

// Opt-in only. Absent is false, "1" or "true" is true, and anything else is a
// 400 rather than a quiet false, so a typo doesn't silently drop the filter.
function parseUnwatchedQuery(raw: unknown): boolean | null {
  if (raw === undefined) {
    return false;
  }
  if (typeof raw !== "string") {
    return null;
  }
  if (raw === "1" || raw === "true") {
    return true;
  }
  return null;
}

// Exactly one character, and only from the set the rail can produce. Plex puts
// this in the URL path, not a query string, so it stays tight.
function parseFirstCharacterQuery(raw: unknown): string | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || !/^[A-Za-z0-9#]$/.test(raw)) {
    return null;
  }
  return raw;
}

// Search text. Whitespace-only collapses to undefined (no filter) instead of
// 400, because that's what an empty search box sends. Over 100 chars is a 400.
function parseTitleQuery(raw: unknown): string | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > 100) {
    return null;
  }
  return trimmed;
}

// Plex failures all become a 502. PlexServerUpstreamError carries the real
// status but it isn't forwarded, so Plex 404ing a section can't make this API
// answer 404.
function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof PlexServerUpstreamError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
