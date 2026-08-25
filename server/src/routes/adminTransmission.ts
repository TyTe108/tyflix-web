// Admin read of Transmission's current torrents and session rates.
//
// Mounted at /api/admin/transmission behind requireAdmin in index.ts, ahead of
// the less-specific /api/admin mount, and only when TRANSMISSION_URL is set.
// Handlers also run isAdmin themselves as defense in depth, matching
// adminBlocklist.ts.
//
// GET /torrents issues torrent-get and session-stats. The torrent-get field
// list is the compact set the 5-second poll can afford: no trackerStats, files,
// peers, or pieces, and no session-scoped id.

import { Router } from "express";
import { isAdmin, type SessionPayload } from "../session";
import {
  TransmissionUpstreamError,
  type TransmissionClient,
} from "../transmission/client";
import {
  normalizeSessionStats,
  normalizeTorrentDetailGetArguments,
  normalizeTorrentGetArguments,
  type TransmissionListResponse,
} from "../transmission/normalize";

export type AdminTransmissionRouterDeps = {
  transmission: Pick<
    TransmissionClient,
    "listTorrents" | "getSessionStats" | "startTorrent" | "stopTorrent"
  >;
};

const TORRENT_GET_FIELDS = [
  "hashString",
  "name",
  "labels",
  "status",
  "percentDone",
  "sizeWhenDone",
  "leftUntilDone",
  "uploadedEver",
  "uploadRatio",
  "rateDownload",
  "rateUpload",
  "eta",
  "peersConnected",
  "peersSendingToUs",
  "peersGettingFromUs",
  "isFinished",
  "isStalled",
  "error",
  "errorString",
  "addedDate",
  "doneDate",
  "queuePosition",
  "downloadDir",
  "recheckProgress",
  "metadataPercentComplete",
] as const;

const TORRENT_DETAIL_FIELDS = [
  "hashString",
  "name",
  "totalSize",
  "pieceCount",
  "pieceSize",
  "isPrivate",
  "comment",
  "creator",
  "dateCreated",
  "addedDate",
  "doneDate",
  "activityDate",
  "downloadDir",
  "downloadedEver",
  "uploadedEver",
  "corruptEver",
  "haveValid",
  "secondsDownloading",
  "secondsSeeding",
  "errorString",
  "files",
  "fileStats",
  "peers",
  "trackerStats",
] as const;

/**
 * Builds the admin Transmission router.
 *
 * requireAdmin is applied at the mount in index.ts, not here.
 */
export function createAdminTransmissionRouter(
  deps: AdminTransmissionRouterDeps,
): Router {
  const { transmission } = deps;
  const router = Router();

  /**
   * GET /api/admin/transmission/torrents
   *
   * Normalised torrent rows plus the session aggregate.
   *
   * Status codes:
   * - 200 with TransmissionListResponse
   * - 401/403 for auth (mount + in-handler isAdmin)
   * - 502 on any TransmissionUpstreamError (upstream status is not forwarded)
   */
  router.get("/torrents", async (_req, res) => {
    if (!requireAdminSession(res)) {
      return;
    }

    try {
      // On a cold client both calls race the 409 handshake and each replays
      // once, so the very first request after boot makes four HTTP calls
      // instead of three. That is expected and harmless.
      const [torrentArgs, sessionArgs] = await Promise.all([
        transmission.listTorrents([...TORRENT_GET_FIELDS]),
        transmission.getSessionStats(),
      ]);
      const body: TransmissionListResponse = {
        torrents: normalizeTorrentGetArguments(torrentArgs),
        session: normalizeSessionStats(sessionArgs),
      };
      res.status(200).json(body);
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.get("/torrents/:hash", async (req, res) => {
    if (!requireAdminSession(res)) {
      return;
    }

    try {
      const torrentArgs = await transmission.listTorrents(
        [...TORRENT_DETAIL_FIELDS],
        [req.params.hash],
      );
      const detail = normalizeTorrentDetailGetArguments(torrentArgs);
      if (detail === null) {
        res.status(404).json({ error: "torrent not found" });
        return;
      }
      res.status(200).json(detail);
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.post("/torrents/:hash/start", async (req, res) => {
    if (!requireAdminSession(res)) {
      return;
    }

    try {
      await transmission.startTorrent(req.params.hash);
      await respondWithVerifiedMutation(
        transmission,
        req.params.hash,
        "start",
        res,
      );
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  router.post("/torrents/:hash/stop", async (req, res) => {
    if (!requireAdminSession(res)) {
      return;
    }

    try {
      await transmission.stopTorrent(req.params.hash);
      await respondWithVerifiedMutation(
        transmission,
        req.params.hash,
        "stop",
        res,
      );
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  return router;
}

async function respondWithVerifiedMutation(
  transmission: AdminTransmissionRouterDeps["transmission"],
  hash: string,
  command: "start" | "stop",
  res: import("express").Response,
): Promise<void> {
  // Transmission returns "success" even for a nonexistent id, so the mutation
  // response proves only that the command parsed. Re-read this hash once and
  // verify the requested state before reporting success to the caller.
  const torrentArgs = await transmission.listTorrents(
    [...TORRENT_GET_FIELDS],
    [hash],
  );
  const torrents = normalizeTorrentGetArguments(torrentArgs);
  const torrent = torrents[0];
  if (torrent === undefined) {
    res.status(404).json({ error: "torrent not found" });
    return;
  }

  const changed = command === "start" ? torrent.status !== 0 : torrent.status === 0;
  if (!changed) {
    throw new TransmissionUpstreamError(
      `Transmission ${command} command was accepted but the state did not change`,
      502,
    );
  }
  res.status(200).json(torrent);
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

// Collapses everything to a 502. TransmissionUpstreamError carries the real
// upstream status, but it isn't forwarded: a sick downloader shouldn't be able
// to make this API answer 404 or 403 on the admin's behalf.
function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof TransmissionUpstreamError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
