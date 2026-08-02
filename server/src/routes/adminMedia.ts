// Admin removal of whole titles and individual TV seasons or episodes.
//
// Whole-title removal through DELETE /api/admin/media/:mediaType/:tmdbId means
// four layers at once:
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
  SonarrUpstreamError,
  type SonarrClient,
  type SonarrEpisode,
  type SonarrEpisodeFile,
} from "../sonarr/client";
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
  sonarr: Pick<
    SonarrClient,
    | "getSeries"
    | "listEpisodes"
    | "listEpisodeFiles"
    | "setSeasonsMonitored"
    | "setEpisodesMonitored"
    | "deleteEpisodeFile"
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

export type AdminMediaRequestLeftOpen = {
  id: number;
  seasons: number[];
};

export type AdminMediaSeasonDeleteResponse = {
  tmdbId: number;
  seasonNumber: number;
  unmonitored: true;
  filesDeleted: number[];
  filesFailedToDelete: Array<{ fileId: number; error: string }>;
  requestsDeclined: number[];
  requestsLeftOpen: AdminMediaRequestLeftOpen[];
};

export type AdminMediaEpisodeDeleteResponse = {
  tmdbId: number;
  episodeId: number;
  seasonNumber: number;
  unmonitored: true;
  fileDeleted: boolean;
  fileId: number | null;
  requestsLeftOpen: AdminMediaRequestLeftOpen[];
};

/**
 * Builds the admin media-removal router.
 *
 * requireAdmin is applied at the mount in index.ts, not here.
 */
export function createAdminMediaRouter(deps: AdminMediaRouterDeps): Router {
  const { seerr, sonarr, mediaStatus, mediaEnrichment } = deps;
  const router = Router();

  /**
   * GET /api/admin/media/tv/:tmdbId/seasons
   *
   * Returns Sonarr's full season/episode tree with episode-file sizes joined by
   * episodeFileId. Specials (season 0) are included.
   *
   * Status codes:
   * - 200 with { tmdbId, sonarrSeriesId, seasons }
   * - 400 for a non-positive-integer tmdbId
   * - 401/403 for auth
   * - 404 when Seerr is not tracking the title
   * - 409 when Seerr has no externalServiceId (the Sonarr series id)
   * - Sonarr's status for upstream failures
   */
  router.get("/tv/:tmdbId/seasons", async (req, res) => {
    if (!requireAdminSession(res)) {
      return;
    }
    const tmdbId = parsePositiveInteger(req.params.tmdbId);
    if (tmdbId === null) {
      res.status(400).json({ error: "tmdbId must be a positive integer" });
      return;
    }

    const resolved = await resolveSonarrSeriesId(mediaStatus, tmdbId, res);
    if (resolved === null) {
      return;
    }

    try {
      const series = await sonarr.getSeries(resolved);
      const episodes = await sonarr.listEpisodes(resolved);
      const files = await sonarr.listEpisodeFiles(resolved);
      const filesById = new Map(files.map((file) => [file.id, file]));

      res.status(200).json({
        tmdbId,
        sonarrSeriesId: resolved,
        seasons: series.seasons.map((season) => {
          const seasonEpisodes = episodes.filter(
            (episode) => episode.seasonNumber === season.seasonNumber,
          );
          const seasonFiles = files.filter(
            (file) => file.seasonNumber === season.seasonNumber,
          );
          return {
            seasonNumber: season.seasonNumber,
            monitored: season.monitored,
            episodeCount: seasonEpisodes.length,
            episodeFileCount: seasonFiles.length,
            sizeOnDisk: seasonFiles.reduce(
              (total, file) => total + file.size,
              0,
            ),
            episodes: seasonEpisodes.map((episode) =>
              toEpisodeView(episode, filesById),
            ),
          };
        }),
      });
    } catch (err) {
      respondUpstreamError(res, err, "Sonarr season listing failed");
    }
  });

  /**
   * DELETE /api/admin/media/tv/:tmdbId/season/:seasonNumber
   *
   * Unmonitors the season first, then deletes its files one at a time. The
   * order is load-bearing: deleting a monitored file creates a gap Sonarr can
   * re-grab. setSeasonsMonitored uses PUT /series/{id}; tested behavior shows
   * seasonpass with monitoringOptions none unmonitors the whole series, while
   * seasonpass without it does not cascade to episodes.
   *
   * Seerr has no partial decline. A request is declined only when every season
   * it covers is removed; otherwise it is returned in requestsLeftOpen.
   *
   * Status codes:
   * - 200 when unmonitoring and every file delete succeeded
   * - 400 for invalid tmdbId or seasonNumber (season 0 is valid)
   * - 401/403 for auth
   * - 404 when Seerr is not tracking the title
   * - 409 when Seerr has no Sonarr series id
   * - The Sonarr status when loading files or unmonitoring fails
   * - 500 with per-file results when any file deletion fails
   */
  router.delete(
    "/tv/:tmdbId/season/:seasonNumber",
    async (req, res) => {
      if (!requireAdminSession(res)) {
        return;
      }
      const tmdbId = parsePositiveInteger(req.params.tmdbId);
      const seasonNumber = parseNonNegativeInteger(req.params.seasonNumber);
      if (tmdbId === null || seasonNumber === null) {
        res.status(400).json({
          error:
            "tmdbId must be positive and seasonNumber must be non-negative integers",
        });
        return;
      }

      const seriesId = await resolveSonarrSeriesId(mediaStatus, tmdbId, res);
      if (seriesId === null) {
        return;
      }

      let seasonFiles: SonarrEpisodeFile[];
      try {
        const files = await sonarr.listEpisodeFiles(seriesId);
        seasonFiles = files.filter(
          (file) => file.seasonNumber === seasonNumber,
        );
        await sonarr.setSeasonsMonitored(seriesId, [seasonNumber], false);
      } catch (err) {
        respondUpstreamError(res, err, "Sonarr season unmonitor failed");
        return;
      }

      const filesDeleted: number[] = [];
      const filesFailedToDelete: Array<{ fileId: number; error: string }> = [];
      for (const file of seasonFiles) {
        try {
          await sonarr.deleteEpisodeFile(file.id);
          filesDeleted.push(file.id);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Episode file delete failed";
          console.error(message);
          filesFailedToDelete.push({ fileId: file.id, error: message });
        }
      }

      const requestsDeclined: number[] = [];
      const requestsLeftOpen: AdminMediaRequestLeftOpen[] = [];
      if (filesFailedToDelete.length === 0) {
        await classifySeasonRequests(
          seerr,
          tmdbId,
          new Set([seasonNumber]),
          requestsDeclined,
          requestsLeftOpen,
        );
      }

      const body: AdminMediaSeasonDeleteResponse = {
        tmdbId,
        seasonNumber,
        unmonitored: true,
        filesDeleted,
        filesFailedToDelete,
        requestsDeclined,
        requestsLeftOpen,
      };
      res.status(filesFailedToDelete.length === 0 ? 200 : 500).json(body);
    },
  );

  /**
   * DELETE /api/admin/media/tv/:tmdbId/episode/:episodeId
   *
   * Unmonitors one episode before deleting its file. Episodes without files
   * still succeed because changing monitoring is meaningful work. Episode
   * removal never declines requests because Seerr cannot partially decline a
   * season; matching open requests are returned for transparency.
   *
   * Status codes:
   * - 200 with the unmonitor/file result and requestsLeftOpen
   * - 400 for invalid tmdbId or episodeId
   * - 401/403 for auth
   * - 404 when the media row or episode is missing
   * - 409 when Seerr has no Sonarr series id
   * - Sonarr's status on an upstream failure
   */
  router.delete(
    "/tv/:tmdbId/episode/:episodeId",
    async (req, res) => {
      if (!requireAdminSession(res)) {
        return;
      }
      const tmdbId = parsePositiveInteger(req.params.tmdbId);
      const episodeId = parsePositiveInteger(req.params.episodeId);
      if (tmdbId === null || episodeId === null) {
        res
          .status(400)
          .json({ error: "tmdbId and episodeId must be positive integers" });
        return;
      }

      const seriesId = await resolveSonarrSeriesId(mediaStatus, tmdbId, res);
      if (seriesId === null) {
        return;
      }

      try {
        const episodes = await sonarr.listEpisodes(seriesId);
        const episode = episodes.find((row) => row.id === episodeId);
        if (episode === undefined) {
          res.status(404).json({ error: "episode not found" });
          return;
        }

        await sonarr.setEpisodesMonitored([episodeId], false);
        let fileDeleted = false;
        let fileId: number | null = null;
        if (episode.hasFile) {
          fileId = episode.episodeFileId;
          await sonarr.deleteEpisodeFile(fileId);
          fileDeleted = true;
        }

        const requestsLeftOpen = await listOpenRequestViews(seerr, tmdbId);
        const body: AdminMediaEpisodeDeleteResponse = {
          tmdbId,
          episodeId,
          seasonNumber: episode.seasonNumber,
          unmonitored: true,
          fileDeleted,
          fileId,
          requestsLeftOpen,
        };
        res.status(200).json(body);
      } catch (err) {
        respondUpstreamError(res, err, "Sonarr episode delete failed");
      }
    },
  );

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

function requireAdminSession(
  res: import("express").Response,
): SessionPayload | null {
  const session = res.locals.session as SessionPayload | undefined;
  if (!session) {
    res.status(401).json({ error: "not authenticated" });
    return null;
  }
  // Intentional redundancy with requireAdmin at the mount: these routes delete
  // files, and mount wiring is not covered by any test.
  if (!isAdmin(session.permissions)) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return session;
}

function parsePositiveInteger(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function parseNonNegativeInteger(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

async function resolveSonarrSeriesId(
  mediaStatus: Pick<MediaStatusProvider, "getMediaRow">,
  tmdbId: number,
  res: import("express").Response,
): Promise<number | null> {
  const mediaRow = await mediaStatus.getMediaRow("tv", tmdbId);
  if (mediaRow === null) {
    res.status(404).json({ error: "media not found" });
    return null;
  }
  if (mediaRow.externalServiceId === null) {
    res.status(409).json({
      error: "Seerr media row has no Sonarr series id",
    });
    return null;
  }
  return mediaRow.externalServiceId;
}

function toEpisodeView(
  episode: SonarrEpisode,
  filesById: ReadonlyMap<number, SonarrEpisodeFile>,
) {
  return {
    id: episode.id,
    episodeNumber: episode.episodeNumber,
    title: episode.title,
    monitored: episode.monitored,
    hasFile: episode.hasFile,
    episodeFileId: episode.episodeFileId,
    size: filesById.get(episode.episodeFileId)?.size ?? 0,
  };
}

function toRequestLeftOpen(request: SeerrRequest): AdminMediaRequestLeftOpen {
  return {
    id: request.id,
    seasons: request.seasons.map((season) => season.seasonNumber),
  };
}

async function listMatchingOpenRequests(
  seerr: Pick<SeerrClient, "listAllRequests">,
  tmdbId: number,
): Promise<SeerrRequest[]> {
  try {
    const requests = await seerr.listAllRequests();
    return requests.filter(
      (request) =>
        (request.status === 1 || request.status === 2) &&
        request.type === "tv" &&
        request.media.tmdbId === tmdbId,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Seerr listAllRequests failed";
    console.error(message);
    return [];
  }
}

async function listOpenRequestViews(
  seerr: Pick<SeerrClient, "listAllRequests">,
  tmdbId: number,
): Promise<AdminMediaRequestLeftOpen[]> {
  const requests = await listMatchingOpenRequests(seerr, tmdbId);
  return requests.map(toRequestLeftOpen);
}

async function classifySeasonRequests(
  seerr: Pick<SeerrClient, "listAllRequests" | "declineRequest">,
  tmdbId: number,
  removedSeasons: ReadonlySet<number>,
  requestsDeclined: number[],
  requestsLeftOpen: AdminMediaRequestLeftOpen[],
): Promise<void> {
  const requests = await listMatchingOpenRequests(seerr, tmdbId);
  for (const request of requests) {
    const requestedSeasons = request.seasons.map(
      (season) => season.seasonNumber,
    );
    // Seerr has no partial decline. Only decline when every requested season
    // was removed; otherwise declining would falsely reject seasons still on
    // the server. An empty season list cannot prove full coverage.
    const fullyCovered =
      requestedSeasons.length > 0 &&
      requestedSeasons.every((season) => removedSeasons.has(season));
    if (!fullyCovered) {
      requestsLeftOpen.push(toRequestLeftOpen(request));
      continue;
    }

    try {
      await seerr.declineRequest(request.id);
      requestsDeclined.push(request.id);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : `Seerr declineRequest ${request.id} failed`;
      console.error(message);
      requestsLeftOpen.push(toRequestLeftOpen(request));
    }
  }
}

function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
  fallback: string,
): void {
  const message = err instanceof Error ? err.message : fallback;
  console.error(message);
  const status =
    err instanceof SonarrUpstreamError || err instanceof SeerrUpstreamError
      ? err.status
      : 502;
  res.status(status).json({ error: message });
}
