// Per-user numbers for the Home page: what you asked for versus what you
// actually watched, plus your Seerr request quota. Mounted at /api/me behind
// requireAuth, with three endpoints: GET /stats, GET /quota, and
// GET /badge-counts.
//
// Both upstreams show up here. Plex supplies the account list and watch history;
// Seerr supplies requests, issues, and quota. The optional local access-request
// store contributes only its pending admin badge count. The analytics module
// does the GB-weighting once the Plex and Seerr sides are joined.
//
// The Plex account list and history are shared across every user, so they're
// cached for a minute at router scope. Without that, each dashboard poll would
// re-pull the entire server history.

import { Router } from "express";
import type { AccessRequestStore } from "../accessRequests/store";
import { computeWatchedVsRequested } from "../analytics/watchedVsRequested";
import {
  PlexServerUpstreamError,
  type PlexServerClient,
  type PlexWatchedSets,
} from "../plex/server";
import {
  SeerrUpstreamError,
  toRequestView,
  type SeerrClient,
  type SeerrRequest,
} from "../seerr/client";
import { isAdmin, type SessionPayload } from "../session";

const SHARED_CACHE_TTL_MS = 60_000;

export type MeRouterDeps = {
  plexServer: PlexServerClient;
  seerr: SeerrClient;
  accessRequestStore?: Pick<AccessRequestStore, "list">;
};

export type BadgeCounts = {
  mine: {
    /** Caller requests pending approval, or non-dead requests with processing media. */
    requests: number;
    /** Caller-created issues whose status is open. */
    issues: number;
  };
  admin: {
    /** All users' requests whose request status is pending. */
    requests: number;
    /** All issues whose status is open. */
    issues: number;
    /** Access-request store rows whose status is pending. */
    access: number;
  } | null;
};

type CacheEntry<T> = {
  at: number; // epoch ms the value was stored, compared against SHARED_CACHE_TTL_MS
  value: T;
};

export function createMeRouter(deps: MeRouterDeps): Router {
  const { plexServer, seerr, accessRequestStore } = deps;
  const router = Router();

  // Server-wide data, not per-user, so one cache serves every caller. Lives for
  // the process lifetime because the router is built once at boot.
  let accountsCache: CacheEntry<Map<number, string>> | null = null;
  let historyCache: CacheEntry<Map<number, PlexWatchedSets>> | null = null;

  // Plex accountID to display name, for every account the PMS knows about.
  async function getAccountsCached(): Promise<Map<number, string>> {
    const now = Date.now();
    if (accountsCache && now - accountsCache.at < SHARED_CACHE_TTL_MS) {
      return accountsCache.value;
    }
    const value = await plexServer.accounts();
    accountsCache = { at: now, value };
    return value;
  }

  // Watched movie and episode ratingKeys, keyed by Plex account id. This is the
  // expensive call of the two, which is most of why the cache exists.
  async function getHistoryCached(): Promise<Map<number, PlexWatchedSets>> {
    const now = Date.now();
    if (historyCache && now - historyCache.at < SHARED_CACHE_TTL_MS) {
      return historyCache.value;
    }
    const value = await plexServer.history();
    historyCache = { at: now, value };
    return value;
  }

  /**
   * GET /api/me/stats
   *
   * Watched-versus-requested for the signed-in user. Returns `plexLinked`, a
   * small `user` block, the computed stats, and a `watchedDefinition` string
   * that spells out what "watched" counts as so the UI never has to guess.
   * No query or body params.
   *
   * 401 without a session, 502 if Plex or Seerr fails.
   *
   * `plexLinked: false` means we couldn't match this session to a Plex account
   * on the server. The response still comes back 200, with empty watch sets, so
   * the page renders requests-only rather than erroring.
   */
  router.get("/stats", async (_req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    try {
      // Three independent reads, two of them usually cache hits. Nothing here
      // depends on anything else, so fire them together.
      const [accounts, historyByAccount, requests] = await Promise.all([
        getAccountsCached(),
        getHistoryCached(),
        seerr.getRequestsByUser(session.seerrUserId),
      ]);

      // Join the Seerr-side session to the Plex-side account, then pull that
      // account's watch sets. An unmatched user gets empty sets, not an error.
      const accountId = resolvePlexAccountId(session, accounts);
      const watched =
        accountId !== null
          ? (historyByAccount.get(accountId) ?? {
              movies: new Set<string>(),
              episodes: new Set<string>(),
            })
          : { movies: new Set<string>(), episodes: new Set<string>() };

      // The analytics module needs file sizes to weight by GB, so it gets a
      // lookup callback rather than a preloaded list. plexServer.item caches
      // internally, which keeps repeat titles from re-hitting Plex.
      const stats = await computeWatchedVsRequested(
        requests,
        watched,
        (rk, isShow) => plexServer.item(rk, isShow),
      );

      res.json({
        plexLinked: accountId !== null,
        user: {
          seerrUserId: session.seerrUserId,
          displayName: session.displayName,
        },
        ...stats,
        watchedDefinition:
          "GB-weighted: watched = size of movies/episodes played to Plex's ~90% flag (per episode for shows)",
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/me/quota
   *
   * Passes Seerr's quota record for the signed-in user straight through, which
   * is what the request UI uses to say "3 of 5 movies left this week". No
   * params. 401 without a session, 502 if Seerr fails.
   */
  router.get("/quota", async (_req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    try {
      res.json(await seerr.getUserQuota(session.seerrUserId));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/me/badge-counts
   *
   * Every nav badge count in one response, split into the caller's own work and
   * admin-wide work. No params. `admin` is explicitly null for a non-admin so
   * clients can distinguish insufficient permission from a missing field.
   *
   * 200 with BadgeCounts, 401 without a session, 502 if a Seerr list fails,
   * and 503 when the auth guard cannot revalidate permissions against Seerr.
   */
  router.get("/badge-counts", async (_req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    try {
      const admin = isAdmin(session.permissions);
      const [mineRequests, issues, allRequests] = await Promise.all([
        seerr.getRequestsByUser(session.seerrUserId),
        seerr.listIssues(),
        admin ? seerr.listAllRequests() : Promise.resolve(undefined),
      ]);

      /*
       * Walked lists are deliberate: measured Seerr /count and request filter
       * totals disagree with both the definitive walk and Tyflix's predicates.
       */
      const counts: BadgeCounts = {
        mine: {
          requests: mineRequests.filter(isMineActiveRequest).length,
          issues: issues.filter(
            (issue) =>
              issue.createdBy.id === session.seerrUserId &&
              issue.status === "open",
          ).length,
        },
        admin: admin
          ? {
              requests: allRequests!.filter(isAdminPendingRequest).length,
              issues: issues.filter((issue) => issue.status === "open").length,
              access:
                accessRequestStore
                  ?.list()
                  .filter((row) => row.status === "pending").length ?? 0,
            }
          : null,
      };

      res.json(counts);
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  return router;
}

// The badge means "things you're still waiting on"; declined and failed
// requests cannot deliver anything, even if Seerr still reports processing.
function isMineActiveRequest(request: SeerrRequest): boolean {
  const view = toRequestView(request, { title: "", posterUrl: null });
  return (
    view.requestStatus === "pending" ||
    (view.mediaStatus === "processing" &&
      view.requestStatus !== "declined" &&
      view.requestStatus !== "failed")
  );
}

function isAdminPendingRequest(request: SeerrRequest): boolean {
  return (
    toRequestView(request, { title: "", posterUrl: null }).requestStatus ===
    "pending"
  );
}

// Finds the caller's Plex accountID, which is the key watch history is filed
// under. The session's plexId usually is that id, but not always, so fall back
// to a case-insensitive username match. Returns null when neither hits, and the
// caller reports that as plexLinked: false.
function resolvePlexAccountId(
  session: SessionPayload,
  accounts: Map<number, string>,
): number | null {
  if (accounts.has(session.plexId)) {
    return session.plexId;
  }

  const target = session.plexUsername.toLowerCase();
  for (const [accountId, name] of accounts) {
    if (name.toLowerCase() === target) {
      return accountId;
    }
  }

  return null;
}

// Either upstream failing lands here as a 502. The typed errors only exist to
// get a useful message into the log and the body.
function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof PlexServerUpstreamError || err instanceof SeerrUpstreamError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
