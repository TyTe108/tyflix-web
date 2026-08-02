// Admin removal of a whole title (movie or series) from the library pipeline.
//
// DELETE /api/admin/media/:mediaType/:tmdbId is the only route. "Remove" here
// means four layers at once:
//   1. Radarr/Sonarr (and the on-disk files) via Seerr's media-file delete
//   2. Plex, which drops the title on its next library scan once the files are
//      gone
//   3. Seerr's media row, flipped to BLOCKLISTED by default so the every-three-
//      minutes plex-watchlist-sync job cannot Auto-Request the title back
//   4. Any still-open Seerr request against that title, declined so the
//      requester sees a terminal state and the quota slot frees
//
// Blocklisting is the default rather than DELETE /media/{id} because deleting
// the media row throws away the only state that stops Auto-Request. Live-
// probed: a title deleted without a blocklist entry is re-requested and re-
// downloaded within minutes. ?blocklist=false is the escape hatch when an
// admin deliberately wants a re-grab.
//
// Mounted at /api/admin/media behind requireAdmin in index.ts, ahead of the
// less-specific /api/admin mount.

import { Router } from "express";
import {
  SeerrUpstreamError,
  type SeerrClient,
  type SeerrRequest,
} from "../seerr/client";
import type { MediaStatusProvider } from "../seerr/mediaStatusProvider";
import { isAdmin, type SessionPayload } from "../session";
import {
  mediaEnrichmentKey,
  type MediaEnrichment,
} from "../tmdb/enrichment";

export type AdminMediaRouterDeps = {
  seerr: Pick<
    SeerrClient,
    | "deleteMediaFile"
    | "deleteMedia"
    | "addToBlocklist"
    | "listAllRequests"
    | "declineRequest"
  >;
  mediaStatus: Pick<MediaStatusProvider, "getMediaRow">;
  mediaEnrichment: MediaEnrichment;
};

export type AdminMediaDeleteResponse = {
  tmdbId: number;
  mediaType: "movie" | "tv";
  filesDeleted: boolean;
  /** true when blocklisted (including Seerr 412 already-blocklisted). null when ?blocklist=false. */
  blocklisted: boolean | null;
  /** true when the Seerr media row was deleted. null when blocklisting. */
  mediaRowDeleted: boolean | null;
  requestsDeclined: number[];
  requestsFailedToDecline: number[];
  error?: string;
};

/**
 * Builds the admin media-removal router.
 *
 * requireAdmin is applied at the mount in index.ts, not here.
 */
export function createAdminMediaRouter(deps: AdminMediaRouterDeps): Router {
  const { seerr, mediaStatus, mediaEnrichment } = deps;
  const router = Router();

  /**
   * DELETE /api/admin/media/:mediaType/:tmdbId
   *
   * Removes a title from Radarr/Sonarr (files included), then either blocklists
   * it in Seerr (default) or deletes the Seerr media row (?blocklist=false),
   * then best-effort declines open requests for that title.
   *
   * Query: `blocklist` optional. Absent or "true" → addToBlocklist. "false" →
   * deleteMedia. Any other value → 400.
   *
   * Status codes:
   * - 200: files deleted and the second step reached its desired end state
   *   (blocklisted, including Seerr 412 already-blocklisted, or media row
   *   deleted). Decline failures stay 200 and land in requestsFailedToDecline.
   * - 400: bad mediaType, tmdbId, or blocklist query. Nothing upstream called.
   * - 401: no session. 403: session present but not admin (also enforced here
   *   as defense in depth alongside requireAdmin at the mount).
   * - 404: Seerr is not tracking the title. Nothing deleted.
   * - 502/504/other: deleteMediaFile failed; status forwarded from
   *   SeerrUpstreamError. Blocklist and declines are not attempted.
   * - 500: deleteMediaFile succeeded but the blocklist/deleteMedia step
   *   failed. Body carries filesDeleted:true and blocklisted:false (or
   *   mediaRowDeleted:false) plus error. Must not be read as success: the
   *   files are gone and the title can come back on the next sync.
   */
  router.delete("/:mediaType/:tmdbId", async (req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    // Intentional redundancy with requireAdmin at the mount: this route deletes
    // files, and mount wiring is not covered by any test.
    if (!isAdmin(session.permissions)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const mediaTypeRaw = req.params.mediaType;
    if (mediaTypeRaw !== "movie" && mediaTypeRaw !== "tv") {
      res.status(400).json({ error: "mediaType must be movie or tv" });
      return;
    }
    const mediaType = mediaTypeRaw;

    const tmdbIdRaw = req.params.tmdbId;
    if (!/^\d+$/.test(tmdbIdRaw)) {
      res.status(400).json({ error: "tmdbId must be a positive integer" });
      return;
    }
    const tmdbId = Number(tmdbIdRaw);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
      res.status(400).json({ error: "tmdbId must be a positive integer" });
      return;
    }

    const blocklistParam = req.query.blocklist;
    let shouldBlocklist = true;
    if (blocklistParam !== undefined) {
      if (blocklistParam === "true") {
        shouldBlocklist = true;
      } else if (blocklistParam === "false") {
        shouldBlocklist = false;
      } else {
        res.status(400).json({ error: 'blocklist must be "true" or "false"' });
        return;
      }
    }

    const mediaRow = await mediaStatus.getMediaRow(mediaType, tmdbId);
    if (mediaRow === null) {
      res.status(404).json({ error: "media not found" });
      return;
    }

    try {
      await seerr.deleteMediaFile(mediaRow.id);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Seerr deleteMediaFile failed";
      console.error(message);
      const status = err instanceof SeerrUpstreamError ? err.status : 502;
      res.status(status).json({ error: message });
      return;
    }

    let blocklisted: boolean | null = null;
    let mediaRowDeleted: boolean | null = null;

    if (shouldBlocklist) {
      let title: string | undefined;
      try {
        const enriched = await mediaEnrichment.enrich([{ mediaType, tmdbId }]);
        title = enriched.get(mediaEnrichmentKey({ mediaType, tmdbId }))?.title;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "TMDB title lookup failed";
        console.error(message);
      }

      try {
        await seerr.addToBlocklist({
          tmdbId,
          mediaType,
          userId: session.seerrUserId,
          ...(title === undefined ? {} : { title }),
        });
        blocklisted = true;
      } catch (err) {
        if (err instanceof SeerrUpstreamError && err.status === 412) {
          // Already blocklisted: desired end state holds.
          blocklisted = true;
        } else {
          const message =
            err instanceof Error ? err.message : "Seerr addToBlocklist failed";
          console.error(message);
          const body: AdminMediaDeleteResponse = {
            tmdbId,
            mediaType,
            filesDeleted: true,
            blocklisted: false,
            mediaRowDeleted: null,
            requestsDeclined: [],
            requestsFailedToDecline: [],
            error: message,
          };
          res.status(500).json(body);
          return;
        }
      }
    } else {
      try {
        await seerr.deleteMedia(mediaRow.id);
        mediaRowDeleted = true;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Seerr deleteMedia failed";
        console.error(message);
        const body: AdminMediaDeleteResponse = {
          tmdbId,
          mediaType,
          filesDeleted: true,
          blocklisted: null,
          mediaRowDeleted: false,
          requestsDeclined: [],
          requestsFailedToDecline: [],
          error: message,
        };
        res.status(500).json(body);
        return;
      }
    }

    const requestsDeclined: number[] = [];
    const requestsFailedToDecline: number[] = [];
    try {
      const requests = await seerr.listAllRequests();
      const open = requests.filter((reqRow) =>
        isOpenRequestForTitle(reqRow, mediaType, tmdbId),
      );
      for (const openReq of open) {
        try {
          await seerr.declineRequest(openReq.id);
          requestsDeclined.push(openReq.id);
        } catch (err) {
          const message =
            err instanceof Error
              ? err.message
              : `Seerr declineRequest ${openReq.id} failed`;
          console.error(message);
          requestsFailedToDecline.push(openReq.id);
        }
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Seerr listAllRequests failed";
      console.error(message);
    }

    const body: AdminMediaDeleteResponse = {
      tmdbId,
      mediaType,
      filesDeleted: true,
      blocklisted,
      mediaRowDeleted,
      requestsDeclined,
      requestsFailedToDecline,
    };
    res.status(200).json(body);
  });

  return router;
}

function isOpenRequestForTitle(
  request: SeerrRequest,
  mediaType: "movie" | "tv",
  tmdbId: number,
): boolean {
  // 1 = pending, 2 = approved.
  if (request.status !== 1 && request.status !== 2) {
    return false;
  }
  return request.type === mediaType && request.media.tmdbId === tmdbId;
}
