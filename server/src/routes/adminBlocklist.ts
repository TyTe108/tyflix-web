// Admin CRUD over Seerr's blocklist.
//
// The blocklist is what stops Seerr's every-three-minutes plex-watchlist-sync
// job from Auto-Requesting a title that an admin has deliberately removed.
// The guard Seerr actually checks is media.status === BLOCKLISTED rather than
// the blocklist table itself; adding a row sets that status (and creates the
// media row if needed), and removing a row deletes the media row too.
//
// Un-blocklisting can therefore start a download within three minutes if the
// title is still on anybody's Plex Watchlist with Auto-Request enabled. This
// router surfaces that risk in its DELETE response; it does not try to measure
// whether the title is currently on a watchlist.
//
// Mounted at /api/admin/blocklist behind requireAdmin in index.ts, ahead of
// the less-specific /api/admin mount. Handlers also run isAdmin themselves as
// defense in depth, matching adminMedia.ts.

import { Router } from "express";
import {
  SeerrUpstreamError,
  type SeerrBlocklistItem,
  type SeerrClient,
} from "../seerr/client";
import { isAdmin, type SessionPayload } from "../session";
import {
  mediaEnrichmentKey,
  type MediaEnrichment,
} from "../tmdb/enrichment";

export type AdminBlocklistRouterDeps = {
  seerr: Pick<
    SeerrClient,
    "listBlocklist" | "addToBlocklist" | "removeFromBlocklist"
  >;
  mediaEnrichment: MediaEnrichment;
};

export type AdminBlocklistListResponse = {
  results: SeerrBlocklistItem[];
  total: number;
  take: number;
  skip: number;
};

export type AdminBlocklistAddResponse = {
  tmdbId: number;
  mediaType: "movie" | "tv";
  alreadyBlocklisted: boolean;
};

export type AdminBlocklistRemoveResponse = {
  tmdbId: number;
  mediaType: "movie" | "tv";
  mediaRowDeleted: boolean;
  willBeAutoRequested: boolean;
  warnings: string[];
};

const DEFAULT_TAKE = 25;
const MAX_TAKE = 100;

/**
 * Builds the admin blocklist router.
 *
 * requireAdmin is applied at the mount in index.ts, not here.
 */
export function createAdminBlocklistRouter(
  deps: AdminBlocklistRouterDeps,
): Router {
  const { seerr, mediaEnrichment } = deps;
  const router = Router();

  /**
   * GET /api/admin/blocklist
   *
   * One page of blocklist rows. Query: take (default 25, 1..100), skip
   * (default 0, >= 0), optional search. Returns { results, total, take, skip }.
   *
   * Status codes:
   * - 200 with the page
   * - 400 for bad take/skip
   * - 401/403 for auth (mount + in-handler isAdmin)
   * - Seerr upstream status on failure
   */
  router.get("/", async (req, res) => {
    if (!requireAdminSession(res)) {
      return;
    }

    const takeParsed = parseOptionalInt(req.query.take, DEFAULT_TAKE);
    const skipParsed = parseOptionalInt(req.query.skip, 0);
    if (
      takeParsed === null ||
      skipParsed === null ||
      takeParsed < 1 ||
      takeParsed > MAX_TAKE ||
      skipParsed < 0
    ) {
      res.status(400).json({ error: "invalid take or skip" });
      return;
    }

    const searchRaw = req.query.search;
    const search =
      typeof searchRaw === "string" && searchRaw.length > 0
        ? searchRaw
        : undefined;

    try {
      const page = await seerr.listBlocklist({
        take: takeParsed,
        skip: skipParsed,
        ...(search === undefined ? {} : { search }),
      });
      const body: AdminBlocklistListResponse = {
        results: page.results,
        total: page.total,
        take: takeParsed,
        skip: skipParsed,
      };
      res.status(200).json(body);
    } catch (err) {
      respondUpstreamError(res, err, "Seerr listBlocklist failed");
    }
  });

  /**
   * POST /api/admin/blocklist
   *
   * Body { tmdbId, mediaType, title? }. userId comes from the session, never
   * the body. When title is omitted, looks it up via mediaEnrichment and
   * continues without it if that fails. Does not delete files or touch
   * Radarr/Sonarr.
   *
   * Status codes:
   * - 201 { tmdbId, mediaType, alreadyBlocklisted: false } on a new entry
   * - 200 { tmdbId, mediaType, alreadyBlocklisted: true } on Seerr 412
   *   (already blocklisted); the desired end state holds
   * - 400 for bad body
   * - 401/403 for auth
   * - Seerr upstream status on other failures
   */
  router.post("/", async (req, res) => {
    const session = requireAdminSession(res);
    if (!session) {
      return;
    }

    const parsed = parseBlocklistIdentity(req.body);
    if (parsed === null) {
      res.status(400).json({ error: "invalid tmdbId or mediaType" });
      return;
    }
    const { tmdbId, mediaType } = parsed;

    let title: string | undefined;
    if (typeof req.body?.title === "string" && req.body.title.length > 0) {
      title = req.body.title;
    } else {
      try {
        const enriched = await mediaEnrichment.enrich([{ mediaType, tmdbId }]);
        title = enriched.get(mediaEnrichmentKey({ mediaType, tmdbId }))?.title;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "TMDB title lookup failed";
        console.error(message);
      }
    }

    try {
      await seerr.addToBlocklist({
        tmdbId,
        mediaType,
        userId: session.seerrUserId,
        ...(title === undefined ? {} : { title }),
      });
      const body: AdminBlocklistAddResponse = {
        tmdbId,
        mediaType,
        alreadyBlocklisted: false,
      };
      res.status(201).json(body);
    } catch (err) {
      if (err instanceof SeerrUpstreamError && err.status === 412) {
        const body: AdminBlocklistAddResponse = {
          tmdbId,
          mediaType,
          alreadyBlocklisted: true,
        };
        res.status(200).json(body);
        return;
      }
      respondUpstreamError(res, err, "Seerr addToBlocklist failed");
    }
  });

  /**
   * DELETE /api/admin/blocklist/:mediaType/:tmdbId
   *
   * Removes a blocklist entry. Seerr also deletes the matching media row (and
   * cascaded request history). Returns warnings about that cascade and about
   * Auto-Request re-eligibility. willBeAutoRequested is true on any successful
   * removal; this flags the possibility rather than measuring watchlists.
   *
   * Status codes:
   * - 200 with { tmdbId, mediaType, mediaRowDeleted, willBeAutoRequested,
   *   warnings }. mediaRowDeleted false means Seerr removed the blocklist row
   *   then 404'd looking for a media row; the entry is gone but cleanup was
   *   partial, and warnings say so.
   * - 400 for bad params
   * - 401/403 for auth
   * - Seerr upstream status on other failures (including non-404 errors from
   *   removeFromBlocklist; 404 is already resolved by the client as
   *   mediaRowDeleted: false)
   */
  router.delete("/:mediaType/:tmdbId", async (req, res) => {
    if (!requireAdminSession(res)) {
      return;
    }

    const parsed = parseBlocklistIdentity({
      mediaType: req.params.mediaType,
      tmdbId: req.params.tmdbId,
    });
    if (parsed === null) {
      res.status(400).json({ error: "invalid tmdbId or mediaType" });
      return;
    }
    const { tmdbId, mediaType } = parsed;

    try {
      const result = await seerr.removeFromBlocklist(tmdbId, mediaType);
      const warnings: string[] = [];
      if (!result.mediaRowDeleted) {
        warnings.push(
          "Blocklist entry removed, but Seerr could not find a media row to delete (partial cleanup).",
        );
      }
      warnings.push(
        "Removing a blocklist entry also deletes the Seerr media row, which cascades to that title's request history.",
      );
      warnings.push(
        "If this title is still on a Plex Watchlist with Auto-Request enabled, plex-watchlist-sync may re-request it within about three minutes.",
      );

      const body: AdminBlocklistRemoveResponse = {
        tmdbId,
        mediaType,
        mediaRowDeleted: result.mediaRowDeleted,
        willBeAutoRequested: true,
        warnings,
      };
      res.status(200).json(body);
    } catch (err) {
      respondUpstreamError(res, err, "Seerr removeFromBlocklist failed");
    }
  });

  return router;
}

function requireAdminSession(
  res: import("express").Response,
): SessionPayload | null {
  const session = res.locals.session as SessionPayload | undefined;
  if (!session) {
    res.status(401).json({ error: "not authenticated" });
    return null;
  }
  // Intentional redundancy with requireAdmin at the mount: mount wiring is not
  // covered by any test.
  if (!isAdmin(session.permissions)) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return session;
}

function parseOptionalInt(
  raw: unknown,
  defaultValue: number,
): number | null {
  if (raw === undefined) {
    return defaultValue;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return null;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    return null;
  }
  return n;
}

function parseBlocklistIdentity(
  raw: unknown,
): { tmdbId: number; mediaType: "movie" | "tv" } | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const mediaType = (raw as { mediaType?: unknown }).mediaType;
  if (mediaType !== "movie" && mediaType !== "tv") {
    return null;
  }

  const tmdbIdRaw = (raw as { tmdbId?: unknown }).tmdbId;
  let tmdbId: number;
  if (typeof tmdbIdRaw === "number") {
    tmdbId = tmdbIdRaw;
  } else if (typeof tmdbIdRaw === "string" && /^\d+$/.test(tmdbIdRaw)) {
    tmdbId = Number(tmdbIdRaw);
  } else {
    return null;
  }
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return null;
  }

  return { tmdbId, mediaType };
}

function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
  fallback: string,
): void {
  const message = err instanceof Error ? err.message : fallback;
  console.error(message);
  const status = err instanceof SeerrUpstreamError ? err.status : 502;
  res.status(status).json({ error: message });
}
