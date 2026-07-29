// "Report a problem" on a title: wrong cut, bad audio, missing subtitles. This
// is Seerr's issue tracker with a Tyflix front end on it. Mounted at
// /api/issues behind requireAuth, with six endpoints:
//
//   GET  /              the caller's own issues
//   GET  /all           everyone's issues (admin)
//   POST /              open an issue against a title
//   GET  /:id           one issue
//   POST /:id/comment   add a comment
//   POST /:id/status    open or resolve
//
// requireAuth covers the mount. Authorization past that is per-issue rather
// than per-route: canAccessIssue lets you touch an issue if you filed it or if
// you're an admin, and GET /all checks the admin bit inline. One consequence
// worth knowing is that a non-admin can resolve their own issue.
//
// Seerr is the store. TMDB fills in titles and posters, since Seerr's issue
// rows only carry media ids. Requests go through mediaStatus first to turn a
// TMDB id into Seerr's internal media id, which is the join this app does
// everywhere.

import { Router, type Response } from "express";
import type { SeerrClient } from "../seerr/client";
import type {
  IssueStatus,
  IssueType,
  IssueView,
} from "../seerr/issues";
import type { MediaStatusProvider } from "../seerr/mediaStatusProvider";
import { isAdmin, type SessionPayload } from "../session";
import {
  mediaEnrichmentKey,
  type MediaEnrichment,
} from "../tmdb/enrichment";

export type IssuesRouterDeps = {
  seerr: Pick<
    SeerrClient,
    | "listIssues"
    | "getIssue"
    | "createIssue"
    | "addIssueComment"
    | "setIssueStatus"
  >;
  mediaStatus: MediaStatusProvider;
  mediaEnrichment: MediaEnrichment;
};

export function createIssuesRouter(deps: IssuesRouterDeps): Router {
  const { seerr, mediaStatus, mediaEnrichment } = deps;
  const router = Router();

  /**
   * GET /api/issues
   *
   * The caller's own issues as `{ results }`, each with a TMDB title and
   * poster attached. No params. 401 without a session, 502 if Seerr fails.
   *
   * Seerr has no per-user issue endpoint, so this pulls the full list and
   * filters it here. Fine at household scale, and worth knowing about if the
   * list ever gets big.
   */
  router.get("/", async (_req, res) => {
    const session = requireSession(res);
    if (session === null) {
      return;
    }

    try {
      const all = await seerr.listIssues();
      const mine = all.filter(
        (issue) => issue.createdBy.id === session.seerrUserId,
      );
      res.json({
        results: await enrichIssues(mine, mediaEnrichment),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/issues/all
   *
   * Every user's issues, for the admin queue. Same enriched `{ results }`
   * shape as GET /. 401 without a session, 403 for non-admins, 502 if Seerr
   * fails.
   *
   * The admin check is inline rather than requireAdmin middleware, which keeps
   * this router mountable behind plain requireAuth.
   */
  router.get("/all", async (_req, res) => {
    const session = requireSession(res);
    if (session === null) {
      return;
    }
    if (!isAdmin(session.permissions)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    try {
      const issues = await seerr.listIssues();
      res.json({
        results: await enrichIssues(issues, mediaEnrichment),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * POST /api/issues
   *
   * Body: `tmdbId`, `mediaType` (movie|tv), `issueType`
   * (video|audio|subtitles|other) and `message`, all required, plus optional
   * `problemSeason` and `problemEpisode` for pinning a TV issue to one episode.
   *
   * 201 with Seerr's new issue on success. 400 for a bad body, 401 without a
   * session, 404 when Seerr has no media record for that TMDB id, 502 if Seerr
   * fails.
   *
   * Attributed to the caller's Seerr user id, so the issue shows up under the
   * right name in Seerr itself.
   */
  router.post("/", async (req, res) => {
    const session = requireSession(res);
    if (session === null) {
      return;
    }
    const parsed = parseCreateIssueBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      // Seerr files issues against its own media id, not a TMDB id, so the
      // join has to happen before anything is created. No record means Seerr
      // has never seen this title and there's nothing to attach an issue to.
      const mediaId = await mediaStatus.getMediaId(
        parsed.mediaType,
        parsed.tmdbId,
      );
      if (mediaId === null) {
        res.status(404).json({ error: "media not tracked" });
        return;
      }
      const issue = await seerr.createIssue({
        issueType: parsed.issueType,
        message: parsed.message,
        mediaId,
        userId: session.seerrUserId,
        ...(parsed.problemSeason === undefined
          ? {}
          : { problemSeason: parsed.problemSeason }),
        ...(parsed.problemEpisode === undefined
          ? {}
          : { problemEpisode: parsed.problemEpisode }),
      });
      res.status(201).json(issue);
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * GET /api/issues/:id
   *
   * One issue, enriched, for the detail page. `:id` is Seerr's issue id.
   * 400 for a non-numeric id, 401 without a session, 403 unless you filed it or
   * you're an admin, 502 if Seerr fails.
   *
   * An id Seerr doesn't know comes back as 502, not 404, because the fetch
   * throws before the ownership check runs.
   */
  router.get("/:id", async (req, res) => {
    const session = requireSession(res);
    if (session === null) {
      return;
    }
    const id = parseNumericId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid issue id" });
      return;
    }

    try {
      const issue = await seerr.getIssue(id);
      if (!canAccessIssue(issue, session)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const [enriched] = await enrichIssues([issue], mediaEnrichment);
      res.json(enriched);
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * POST /api/issues/:id/comment
   *
   * Body: `message`, non-empty after trimming. Returns Seerr's updated issue.
   * 400 for a bad id or an empty message, 401 without a session, 403 unless
   * you filed it or you're an admin, 502 if Seerr fails.
   *
   * The issue is fetched first purely to run the ownership check, since Seerr's
   * comment endpoint doesn't do that for us.
   */
  router.post("/:id/comment", async (req, res) => {
    const session = requireSession(res);
    if (session === null) {
      return;
    }
    const id = parseNumericId(req.params.id);
    const message = parseMessage(req.body);
    if (id === null || message === null) {
      res.status(400).json({
        error: id === null ? "invalid issue id" : "message is required",
      });
      return;
    }

    try {
      const issue = await seerr.getIssue(id);
      if (!canAccessIssue(issue, session)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      // TODO: The admin API key makes Seerr attribute comments to its owner,
      // not the acting Tyflix user. Issue creation is attributed with userId.
      res.json(await seerr.addIssueComment(id, message));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  /**
   * POST /api/issues/:id/status
   *
   * Body: `status`, either "open" or "resolved". Returns Seerr's updated issue.
   * 400 for a bad id or status, 401 without a session, 403 unless you filed it
   * or you're an admin, 502 if Seerr fails.
   *
   * The access check is the same canAccessIssue used for reading, so a reporter
   * can resolve or reopen their own issue without an admin.
   */
  router.post("/:id/status", async (req, res) => {
    const session = requireSession(res);
    if (session === null) {
      return;
    }
    const id = parseNumericId(req.params.id);
    const status = parseStatus(req.body);
    if (id === null || status === null) {
      res.status(400).json({
        error: id === null ? "invalid issue id" : "invalid issue status",
      });
      return;
    }

    try {
      const issue = await seerr.getIssue(id);
      if (!canAccessIssue(issue, session)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      res.json(await seerr.setIssueStatus(id, status));
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

  return router;
}

// Validated POST / body. Keyed on tmdbId because that's what the browser has;
// the route swaps it for Seerr's media id before creating anything.
type CreateIssueBody = {
  tmdbId: number;
  mediaType: "movie" | "tv";
  issueType: IssueType;
  message: string;
  problemSeason?: number; // 0 is accepted, not just 1 and up
  problemEpisode?: number;
};

// Validates the create body, returning the first failure rather than a list.
// Season and episode allow 0 but reject negatives and non-integers.
function parseCreateIssueBody(
  body: unknown,
): CreateIssueBody | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "invalid body" };
  }
  const row = body as Record<string, unknown>;
  if (!isPositiveInteger(row.tmdbId)) {
    return { error: "tmdbId must be a positive integer" };
  }
  if (row.mediaType !== "movie" && row.mediaType !== "tv") {
    return { error: "mediaType must be movie or tv" };
  }
  if (!isIssueType(row.issueType)) {
    return { error: "invalid issue type" };
  }
  if (typeof row.message !== "string" || row.message.trim() === "") {
    return { error: "message is required" };
  }
  if (
    row.problemSeason !== undefined &&
    !isNonNegativeInteger(row.problemSeason)
  ) {
    return { error: "problemSeason must be a non-negative integer" };
  }
  if (
    row.problemEpisode !== undefined &&
    !isNonNegativeInteger(row.problemEpisode)
  ) {
    return { error: "problemEpisode must be a non-negative integer" };
  }

  return {
    tmdbId: row.tmdbId,
    mediaType: row.mediaType,
    issueType: row.issueType,
    message: row.message.trim(),
    ...(row.problemSeason === undefined
      ? {}
      : { problemSeason: row.problemSeason }),
    ...(row.problemEpisode === undefined
      ? {}
      : { problemEpisode: row.problemEpisode }),
  };
}

// Comment text, trimmed. Null for anything missing or whitespace-only.
function parseMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" && message.trim() !== ""
    ? message.trim()
    : null;
}

// The two statuses Seerr accepts as a path segment on its status endpoint.
function parseStatus(body: unknown): IssueStatus | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const status = (body as { status?: unknown }).status;
  return status === "open" || status === "resolved" ? status : null;
}

// Seerr issue ids from the URL. Digits only, positive, safe-integer range.
function parseNumericId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return isPositiveInteger(id) ? id : null;
}

// Mirrors Seerr's issue categories. Keep in step with the IssueType union.
function isIssueType(value: unknown): value is IssueType {
  return (
    value === "video" ||
    value === "audio" ||
    value === "subtitles" ||
    value === "other"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Pulls the session requireAuth left in res.locals, answering 401 and returning
// null if it somehow isn't there. Every handler starts with this, so a null
// return means the response is already sent and the handler should just stop.
function requireSession(res: Response): SessionPayload | null {
  const session = res.locals.session as SessionPayload | undefined;
  if (!session) {
    res.status(401).json({ error: "not authenticated" });
    return null;
  }
  return session;
}

// The whole authorization model for this router: your own issue, or you're an
// admin. Applies to reading, commenting and status changes alike.
function canAccessIssue(
  issue: IssueView,
  session: SessionPayload,
): boolean {
  return (
    issue.createdBy.id === session.seerrUserId ||
    isAdmin(session.permissions)
  );
}

// Swaps in TMDB titles and posters on each issue's media block. One batched
// enrichment call covers the whole list, and anything TMDB couldn't resolve is
// left exactly as Seerr sent it rather than blanked.
async function enrichIssues(
  issues: IssueView[],
  mediaEnrichment: MediaEnrichment,
): Promise<IssueView[]> {
  const enriched = await mediaEnrichment.enrich(
    issues.map((issue) => issue.media),
  );
  return issues.map((issue) => {
    const media = enriched.get(mediaEnrichmentKey(issue.media));
    return media === undefined
      ? issue
      : {
          ...issue,
          media: {
            ...issue.media,
            title: media.title,
            posterUrl: media.posterUrl,
          },
        };
  });
}

// Seerr and TMDB failures both land here as a 502.
function respondUpstreamError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
