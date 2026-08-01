// Media requests. Mounted at /api/requests behind requireAuth, with six
// endpoints:
//
//   GET  /profiles              quality profiles for the request dialog (admin)
//   POST /                      create a request
//   GET  /                      the caller's own requests
//   GET  /all                   everyone's requests (admin)
//   POST /:id/approve           approve (admin)
//   POST /:id/decline           decline (admin)
//
// requireAuth covers the mount; the four admin routes stack their own
// requireAdmin on top, and POST / checks the admin bit inline because only the
// optional profileId field needs it.
//
// Tyflix doesn't run the download pipeline. Seerr does, and Radarr and Sonarr
// sit behind Seerr. Everything here is a thin pass to Seerr plus a TMDB lookup
// for the title and poster, since Seerr's request rows only carry ids.

import { Router } from "express";
import { requireAdmin } from "../middleware/auth";
import {
  SeerrUpstreamError,
  toRequestView,
  type RequestView,
  type SeerrClient,
  type SeerrRequest,
} from "../seerr/client";
import { isAdmin, type SessionPayload } from "../session";
import type { TmdbClient } from "../tmdb/client";

export type RequestsRouterDeps = {
  seerr: Pick<
    SeerrClient,
    | "listAllRequests"
    | "listUserRequests"
    | "getServiceProfiles"
    | "createRequest"
    | "approveRequest"
    | "declineRequest"
    | "getUserById"
  >;
  tmdb: Pick<TmdbClient, "movieDetail" | "tvDetail">;
  sessionSecret: string;
};

export function createRequestsRouter(deps: RequestsRouterDeps): Router {
  const { seerr, tmdb, sessionSecret } = deps;
  const router = Router();
  const admin = requireAdmin(sessionSecret, seerr);

  /**
   * GET /api/requests/profiles?mediaType=movie|tv
   *
   * Radarr or Sonarr quality profiles as Seerr reports them, so an admin can
   * pick one when requesting. 400 if mediaType is missing or not movie/tv,
   * 403 for non-admins, 502 if Seerr fails.
   */
  router.get("/profiles", admin, async (req, res) => {
    const mediaType =
      typeof req.query.mediaType === "string" ? req.query.mediaType : undefined;
    if (mediaType !== "movie" && mediaType !== "tv") {
      res.status(400).json({ error: "mediaType must be movie or tv" });
      return;
    }

    try {
      res.json(await seerr.getServiceProfiles(mediaType));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * POST /api/requests
   *
   * Body: `tmdbId` and `mediaType` (required), `seasons` (tv only, defaults to
   * the whole show when omitted), and `profileId` for a quality override.
   *
   * 201 with the enriched request view on success. 400 for a malformed body,
   * 401 without a session, 403 when a non-admin passes profileId, 409 when
   * Seerr says it's already requested, 502 for anything else upstream.
   *
   * The request is attributed to the caller's Seerr user id, not to the API
   * key's owner. That's what keeps quotas and auto-approve rules pointed at the
   * right person; the client handles the header side of it.
   */
  router.post("/", async (req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    const parsed = parseCreateBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    // Picking a quality profile is an admin-only power, so gate on the field
    // rather than the route. Everyone else gets Seerr's default profile.
    if (
      parsed.profileId !== undefined &&
      !isAdmin(session.permissions)
    ) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    try {
      // Seerr won't accept a profileId without the serverId it belongs to, and
      // only the profile listing knows that pairing, so fetch it here.
      const profileOverride =
        parsed.profileId === undefined
          ? {}
          : {
              profileId: parsed.profileId,
              serverId: (
                await seerr.getServiceProfiles(parsed.mediaType)
              ).serverId,
            };
      const request = await seerr.createRequest({
        mediaType: parsed.mediaType,
        tmdbId: parsed.tmdbId,
        ...(parsed.mediaType === "tv" && parsed.seasons !== undefined
          ? { seasons: parsed.seasons }
          : {}),
        userId: session.seerrUserId,
        ...profileOverride,
      });
      const view = await enrichRequest(request, tmdb, new Map());
      res.status(201).json(view);
    } catch (err) {
      // Seerr's 409 is a duplicate request, which is a normal thing for a user
      // to do. Pass it through instead of flattening it into a 502.
      if (err instanceof SeerrUpstreamError && err.status === 409) {
        res.status(409).json({ error: "already requested" });
        return;
      }
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/requests
   *
   * The caller's own requests, in whatever order Seerr returns them, each
   * enriched with a TMDB title and poster. No params. 401 without a session,
   * 502 if Seerr fails.
   */
  router.get("/", async (_req, res) => {
    const session = res.locals.session as SessionPayload | undefined;
    if (!session) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    try {
      const requests = await seerr.listUserRequests(session.seerrUserId);
      res.json({ results: await enrichRequests(requests, tmdb) });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/requests/all
   *
   * Every user's requests, for the admin queue. Same enriched shape as GET /.
   * 403 for non-admins, 502 if Seerr fails.
   */
  router.get("/all", admin, async (_req, res) => {
    try {
      const requests = await seerr.listAllRequests();
      res.json({ results: await enrichRequests(requests, tmdb) });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * POST /api/requests/:id/approve
   *
   * Approves a Seerr request, which is what actually releases it to Radarr or
   * Sonarr. `:id` is Seerr's request id. Returns the updated, enriched request.
   * 400 for a non-numeric id, 403 for non-admins, 502 if Seerr fails.
   *
   * An id Seerr doesn't recognise comes back as 502, not 404, because the
   * client surfaces every Seerr error the same way.
   */
  router.post("/:id/approve", admin, async (req, res) => {
    const id = parseNumericId(
      typeof req.params.id === "string" ? req.params.id : undefined,
    );
    if (id === null) {
      res.status(400).json({ error: "invalid request id" });
      return;
    }

    try {
      const request = await seerr.approveRequest(id);
      res.json(await enrichRequest(request, tmdb, new Map()));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * POST /api/requests/:id/decline
   *
   * Mirror of approve. Returns the updated, enriched request. 400 for a
   * non-numeric id, 403 for non-admins, 502 if Seerr fails.
   */
  router.post("/:id/decline", admin, async (req, res) => {
    const id = parseNumericId(
      typeof req.params.id === "string" ? req.params.id : undefined,
    );
    if (id === null) {
      res.status(400).json({ error: "invalid request id" });
      return;
    }

    try {
      const request = await seerr.declineRequest(id);
      res.json(await enrichRequest(request, tmdb, new Map()));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  return router;
}

// The bit of TMDB metadata a request row is missing. Seerr gives us ids.
type RequestDetail = { title: string; posterUrl: string | null };

// Enriches a whole list in parallel, sharing one in-flight map so a season pack
// or a repeated title only costs a single TMDB call.
async function enrichRequests(
  requests: SeerrRequest[],
  tmdb: Pick<TmdbClient, "movieDetail" | "tvDetail">,
): Promise<RequestView[]> {
  const details = new Map<number, Promise<RequestDetail>>();
  return Promise.all(
    requests.map((request) => enrichRequest(request, tmdb, details)),
  );
}

// Attaches title and poster to one request. The `details` map is keyed by tmdbId
// and holds promises, not values, so concurrent callers await the same lookup.
// Single-request callers pass a throwaway map.
async function enrichRequest(
  request: SeerrRequest,
  tmdb: Pick<TmdbClient, "movieDetail" | "tvDetail">,
  details: Map<number, Promise<RequestDetail>>,
): Promise<RequestView> {
  let detail = details.get(request.media.tmdbId);
  if (detail === undefined) {
    detail =
      request.type === "movie"
        ? tmdb.movieDetail(request.media.tmdbId).then((movie) => ({
            title: movie.title,
            posterUrl: movie.posterUrl,
          }))
        : tmdb.tvDetail(request.media.tmdbId).then((tv) => ({
            title: tv.title,
            posterUrl: tv.posterUrl,
          }));
    details.set(request.media.tmdbId, detail);
  }
  return toRequestView(request, await detail);
}

// Validates the POST / body. The return type is a discriminated union so a
// `seasons` array can only ride along with mediaType "tv"; a movie body that
// includes seasons just drops them. Optional fields are omitted rather than set
// to undefined, which keeps them out of the JSON sent to Seerr.
function parseCreateBody(
  body: unknown,
):
  | { error: string }
  | {
      tmdbId: number;
      mediaType: "movie";
      profileId?: number;
    }
  | {
      tmdbId: number;
      mediaType: "tv";
      seasons?: number[];
      profileId?: number;
    } {
  if (typeof body !== "object" || body === null) {
    return { error: "invalid body" };
  }

  const tmdbId = (body as { tmdbId?: unknown }).tmdbId;
  const mediaType = (body as { mediaType?: unknown }).mediaType;
  const seasons = (body as { seasons?: unknown }).seasons;
  const profileId = (body as { profileId?: unknown }).profileId;

  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId < 1) {
    return { error: "tmdbId must be a positive integer" };
  }
  if (mediaType !== "movie" && mediaType !== "tv") {
    return { error: "mediaType must be movie or tv" };
  }
  if (
    profileId !== undefined &&
    (typeof profileId !== "number" ||
      !Number.isInteger(profileId) ||
      profileId < 1)
  ) {
    return { error: "profileId must be a positive integer" };
  }

  if (mediaType === "tv") {
    if (seasons === undefined) {
      return {
        tmdbId,
        mediaType,
        ...(profileId === undefined ? {} : { profileId }),
      };
    }
    if (!Array.isArray(seasons)) {
      return { error: "seasons must be an array" };
    }
    if (
      seasons.some(
        (season) =>
          typeof season !== "number" ||
          !Number.isInteger(season) ||
          season < 1,
      )
    ) {
      return { error: "seasons must be positive integers" };
    }
    return {
      tmdbId,
      mediaType,
      seasons,
      ...(profileId === undefined ? {} : { profileId }),
    };
  }

  return {
    tmdbId,
    mediaType,
    ...(profileId === undefined ? {} : { profileId }),
  };
}

// Seerr request ids: digits only, positive, inside the safe-integer range.
function parseNumericId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Everything Seerr or TMDB throws becomes a 502, except the 409 that POST /
// intercepts before it gets here.
function respondUpstreamError(
  res: import("express").Response,
  err: unknown,
): void {
  const message =
    err instanceof Error ? err.message : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
