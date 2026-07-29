// Discovery: everything you can browse that isn't necessarily on the server
// yet. Mounted at /api/discover behind requireAuth. Twelve endpoints:
//
//   GET /search?query=&page=              title search
//   GET /trending                         global trending
//   GET /upcoming?mediaType=              coming soon
//   GET /genres?mediaType=                genre list for the filter UI
//   GET /studios                          static studio + network lists
//   GET /browse?mediaType=&...            filtered discovery grid
//   GET /:mediaType/:id/recommendations   more like this
//   GET /:mediaType/:id/credits           cast and crew
//   GET /person/:id                       one person plus their credits
//   GET /collection/:id                   a film collection and its parts
//   GET /movie/:id                        movie detail
//   GET /tv/:id                           show detail
//
// TMDB supplies the metadata. Seerr supplies availability, and gluing those two
// together is the interesting part of this file: TMDB knows the world, Plex
// knows the shelf, and Seerr's media table is the join between them. Every
// media-shaped response gets run through annotateMediaStatus so the UI can mark
// a poster green or amber without a second round trip.
//
// annotateMediaStatus is exported and routes/watchlist.ts imports it, so treat
// it as shared surface rather than a local helper.

import { Router } from "express";
import type { MediaAvailability } from "../seerr/client";
import type { MediaStatusProvider } from "../seerr/mediaStatusProvider";
import { TmdbUpstreamError, type TmdbClient } from "../tmdb/client";
import { NETWORKS, STUDIOS } from "../tmdb/studios";

export type DiscoverRouterDeps = {
  tmdb: TmdbClient;
  mediaStatus: MediaStatusProvider;
};

export function createDiscoverRouter(deps: DiscoverRouterDeps): Router {
  const { tmdb, mediaStatus } = deps;
  const router = Router();

  /**
   * GET /api/discover/search?query=<text>&page=<n>
   *
   * TMDB multi-search, annotated with availability. Returns TMDB's paged
   * envelope with `results` replaced by the annotated rows. `page` defaults to
   * 1 and silently falls back to 1 if it isn't numeric. 400 when `query` is
   * missing or blank, 502 if TMDB fails.
   */
  router.get("/search", async (req, res) => {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    if (query.trim() === "") {
      res.status(400).json({ error: "query is required" });
      return;
    }

    const pageRaw = req.query.page;
    const page =
      typeof pageRaw === "string" && /^\d+$/.test(pageRaw)
        ? Number(pageRaw)
        : 1;

    try {
      const result = await tmdb.search(query, page);
      const statuses = await mediaStatus.getStatusMap();
      res.json({
        ...result,
        results: result.results.map((item) =>
          annotateMediaStatus(item, statuses),
        ),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/discover/trending
   *
   * What TMDB says is trending globally, annotated with availability. This is
   * the Discover page's default rail. No params. 502 if TMDB fails.
   */
  router.get("/trending", async (_req, res) => {
    try {
      const results = await tmdb.trending();
      const statuses = await mediaStatus.getStatusMap();
      res.json({
        results: results.map((item) => annotateMediaStatus(item, statuses)),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/discover/upcoming?mediaType=movie|tv
   *
   * Titles TMDB has scheduled but not released. 400 for a missing or bad
   * mediaType, 502 if TMDB fails. Availability annotation is best-effort here:
   * a Seerr hiccup leaves every row's mediaStatus null instead of failing the
   * whole response.
   */
  router.get("/upcoming", async (req, res) => {
    const mediaType = req.query.mediaType;
    if (mediaType !== "movie" && mediaType !== "tv") {
      res.status(400).json({ error: "invalid media type" });
      return;
    }

    try {
      const results = await tmdb.upcoming(mediaType);
      const statuses = await getStatusMapOrEmpty(mediaStatus);
      res.json({
        results: results.map((item) => annotateMediaStatus(item, statuses)),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/discover/genres?mediaType=movie|tv
   *
   * TMDB's genre list, `{ results }`, for the browse filter. Movie and TV have
   * different genre ids, which is why mediaType is required. 400 for a missing
   * or bad mediaType, 502 if TMDB fails. No availability annotation; these
   * aren't media rows.
   */
  router.get("/genres", async (req, res) => {
    const mediaType = req.query.mediaType;
    if (mediaType !== "movie" && mediaType !== "tv") {
      res.status(400).json({ error: "invalid media type" });
      return;
    }

    try {
      res.json({ results: await tmdb.genres(mediaType) });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/discover/studios
   *
   * `{ studios, networks }`, the curated lists behind the studio and network
   * tiles. Hardcoded in tmdb/studios.ts, so this is synchronous, always 200,
   * and hits nothing upstream. The ids feed /browse as companyId or networkId.
   */
  router.get("/studios", (_req, res) => {
    res.json({ studios: STUDIOS, networks: NETWORKS });
  });

  /**
   * GET /api/discover/browse?mediaType=movie|tv&genreId=&companyId=&networkId=&page=
   *
   * TMDB's discover endpoint, which is what the genre, studio and network pages
   * all run on. Returns TMDB's paged envelope with annotated `results`.
   * 400 for a bad mediaType or any non-numeric filter, 502 if TMDB fails.
   *
   * companyId only applies to movies and networkId only to TV. Passing the
   * wrong one for the media type isn't an error, it's just dropped.
   */
  router.get("/browse", async (req, res) => {
    const mediaType = req.query.mediaType;
    if (mediaType !== "movie" && mediaType !== "tv") {
      res.status(400).json({ error: "invalid media type" });
      return;
    }

    // Each of these can be absent (undefined) or present-and-invalid (null).
    // Only the second is a 400.
    const genreId = parseOptionalNumericQuery(req.query.genreId);
    if (genreId === null) {
      res.status(400).json({ error: "invalid genre id" });
      return;
    }
    const companyId = parseOptionalNumericQuery(req.query.companyId);
    if (companyId === null) {
      res.status(400).json({ error: "invalid company id" });
      return;
    }
    const networkId = parseOptionalNumericQuery(req.query.networkId);
    if (networkId === null) {
      res.status(400).json({ error: "invalid network id" });
      return;
    }
    const page = parseOptionalNumericQuery(req.query.page);
    if (page === null) {
      res.status(400).json({ error: "invalid page" });
      return;
    }

    try {
      const result = await tmdb.discover(mediaType, {
        ...(genreId !== undefined ? { genreId } : {}),
        ...(mediaType === "movie" && companyId !== undefined
          ? { companyId }
          : {}),
        ...(mediaType === "tv" && networkId !== undefined
          ? { networkId }
          : {}),
        ...(page !== undefined ? { page } : {}),
      });
      const statuses = await getStatusMapOrEmpty(mediaStatus);
      res.json({
        ...result,
        results: result.results.map((item) =>
          annotateMediaStatus(item, statuses),
        ),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/discover/:mediaType/:id/recommendations
   *
   * TMDB's "more like this" for one title, annotated. `:mediaType` is movie or
   * tv and `:id` is a TMDB id. 400 for either being wrong, 502 if TMDB fails.
   */
  router.get("/:mediaType/:id/recommendations", async (req, res) => {
    const mediaType = req.params.mediaType;
    if (mediaType !== "movie" && mediaType !== "tv") {
      res.status(400).json({ error: "invalid media type" });
      return;
    }

    const id = parseNumericId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: `invalid ${mediaType} id` });
      return;
    }

    try {
      const results = await tmdb.recommendations(mediaType, id);
      const statuses = await getStatusMapOrEmpty(mediaStatus);
      res.json({
        results: results.map((item) => annotateMediaStatus(item, statuses)),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/discover/:mediaType/:id/credits
   *
   * Cast and crew for a title, passed through from TMDB. 400 for a bad
   * mediaType or id, 502 if TMDB fails. Not annotated: people aren't media.
   */
  router.get("/:mediaType/:id/credits", async (req, res) => {
    const mediaType = req.params.mediaType;
    if (mediaType !== "movie" && mediaType !== "tv") {
      res.status(400).json({ error: "invalid media type" });
      return;
    }

    const id = parseNumericId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: `invalid ${mediaType} id` });
      return;
    }

    try {
      res.json(await tmdb.credits(mediaType, id));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/discover/person/:id
   *
   * One person's TMDB profile plus everything they've been in, as
   * `{ person, credits }` with the credits annotated. 400 for a non-numeric id,
   * 502 if TMDB fails.
   */
  router.get("/person/:id", async (req, res) => {
    const id = parseNumericId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid person id" });
      return;
    }

    try {
      // Two unrelated TMDB documents, so fetch them together rather than
      // stacking the latency.
      const [person, credits] = await Promise.all([
        tmdb.person(id),
        tmdb.personCredits(id),
      ]);
      const statuses = await getStatusMapOrEmpty(mediaStatus);
      res.json({
        person,
        credits: credits.map((item) => annotateMediaStatus(item, statuses)),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/discover/collection/:id
   *
   * A TMDB collection with its `parts` annotated, which is how the UI can show
   * a trilogy and mark the two films already on the server. 400 for a
   * non-numeric id, 502 if TMDB fails.
   */
  router.get("/collection/:id", async (req, res) => {
    const id = parseNumericId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid collection id" });
      return;
    }

    try {
      const collection = await tmdb.collection(id);
      const statuses = await getStatusMapOrEmpty(mediaStatus);
      res.json({
        ...collection,
        parts: collection.parts.map((item) =>
          annotateMediaStatus(item, statuses),
        ),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/discover/movie/:id
   *
   * Movie detail for the title page: TMDB's document with `mediaStatus` layered
   * on, which is what decides whether the page shows Play or Request. 400 for a
   * non-numeric id, 502 if TMDB fails.
   *
   * This calls getStatusMap directly rather than the fall-back-to-empty
   * wrapper. The wrapper is what /upcoming, /browse, /recommendations,
   * /person/:id and /collection/:id use; /search, /trending and /tv/:id call
   * getStatusMap directly like this one does.
   */
  router.get("/movie/:id", async (req, res) => {
    const id = parseNumericId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid movie id" });
      return;
    }

    try {
      const detail = await tmdb.movieDetail(id);
      const statuses = await mediaStatus.getStatusMap();
      res.json(annotateMediaStatus(detail, statuses));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/discover/tv/:id
   *
   * Show detail, the TV twin of /movie/:id. Same annotation and same status
   * codes.
   */
  router.get("/tv/:id", async (req, res) => {
    const id = parseNumericId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid tv id" });
      return;
    }

    try {
      const detail = await tmdb.tvDetail(id);
      const statuses = await mediaStatus.getStatusMap();
      res.json(annotateMediaStatus(detail, statuses));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  return router;
}

/**
 * Stamps a TMDB-shaped item with what Seerr knows about it.
 *
 * This is the TMDB-to-Plex join in one line. The status map is keyed
 * "<mediaType>:<tmdbId>", so anything carrying both fields can be annotated,
 * whether it came from search, a collection, or a person's credits.
 *
 * Shared surface: routes/watchlist.ts imports this too. Exported for that
 * reason, not just for tests.
 *
 * @returns the same object with `mediaStatus` added, null when Seerr has no
 * record of the title, which is the normal case for anything nobody's ever
 * requested.
 */
export function annotateMediaStatus<
  T extends { tmdbId: number; mediaType: "movie" | "tv" },
>(
  item: T,
  statuses: ReadonlyMap<string, MediaAvailability>,
): T & { mediaStatus: MediaAvailability | null } {
  return {
    ...item,
    mediaStatus: statuses.get(`${item.mediaType}:${item.tmdbId}`) ?? null,
  };
}

// TMDB path ids. Digits only; null means reject with a 400.
function parseNumericId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

// Three-way result for optional filters: undefined for absent, null for present
// but invalid, a number when it's usable. The route treats only null as a 400.
function parseOptionalNumericQuery(
  raw: unknown,
): number | undefined | null {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

// Availability is decoration on these routes, not the payload, so a Seerr
// failure degrades to "status unknown" rather than taking the whole response
// down with it. The provider already swallows its own upstream errors, so in
// practice this catch only fires if getStatusMap itself throws.
async function getStatusMapOrEmpty(
  mediaStatus: MediaStatusProvider,
): Promise<ReadonlyMap<string, MediaAvailability>> {
  try {
    return await mediaStatus.getStatusMap();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Seerr media status request failed";
    console.error(`Unable to load Seerr media statuses: ${message}`);
    return new Map();
  }
}

// TMDB failures become a 502 with the upstream message. The status TMDB
// returned isn't forwarded, so a TMDB 404 on an unknown id reads as 502 here.
function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof TmdbUpstreamError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
