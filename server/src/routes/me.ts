import { Router } from "express";
import { computeWatchedVsRequested } from "../analytics/watchedVsRequested";
import {
  PlexServerUpstreamError,
  type PlexServerClient,
  type PlexWatchedSets,
} from "../plex/server";
import { SeerrUpstreamError, type SeerrClient } from "../seerr/client";
import type { SessionPayload } from "../session";

const SHARED_CACHE_TTL_MS = 60_000;

export type MeRouterDeps = {
  plexServer: PlexServerClient;
  seerr: SeerrClient;
};

type CacheEntry<T> = {
  at: number;
  value: T;
};

export function createMeRouter(deps: MeRouterDeps): Router {
  const { plexServer, seerr } = deps;
  const router = Router();

  let accountsCache: CacheEntry<Map<number, string>> | null = null;
  let historyCache: CacheEntry<Map<number, PlexWatchedSets>> | null = null;

  async function getAccountsCached(): Promise<Map<number, string>> {
    const now = Date.now();
    if (accountsCache && now - accountsCache.at < SHARED_CACHE_TTL_MS) {
      return accountsCache.value;
    }
    const value = await plexServer.accounts();
    accountsCache = { at: now, value };
    return value;
  }

  async function getHistoryCached(): Promise<Map<number, PlexWatchedSets>> {
    const now = Date.now();
    if (historyCache && now - historyCache.at < SHARED_CACHE_TTL_MS) {
      return historyCache.value;
    }
    const value = await plexServer.history();
    historyCache = { at: now, value };
    return value;
  }

  router.get("/stats", async (_req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    try {
      const [accounts, historyByAccount, requests] = await Promise.all([
        getAccountsCached(),
        getHistoryCached(),
        seerr.getRequestsByUser(session.seerrUserId),
      ]);

      const accountId = resolvePlexAccountId(session, accounts);
      const watched =
        accountId !== null
          ? (historyByAccount.get(accountId) ?? {
              movies: new Set<string>(),
              episodes: new Set<string>(),
            })
          : { movies: new Set<string>(), episodes: new Set<string>() };

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

  return router;
}

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
