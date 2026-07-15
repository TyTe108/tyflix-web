import { Router, type Response } from "express";
import type { SeerrClient } from "../seerr/client";
import type {
  IssueStatus,
  IssueType,
  IssueView,
} from "../seerr/issues";
import type { MediaStatusProvider } from "../seerr/mediaStatusProvider";
import { isAdmin, type SessionPayload } from "../session";

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
};

export function createIssuesRouter(deps: IssuesRouterDeps): Router {
  const { seerr, mediaStatus } = deps;
  const router = Router();

  router.get("/", async (_req, res) => {
    const session = requireSession(res);
    if (session === null) {
      return;
    }

    try {
      const all = await seerr.listIssues();
      res.json({
        results: all.filter(
          (issue) => issue.createdBy.id === session.seerrUserId,
        ),
      });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

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
      res.json({ results: await seerr.listIssues() });
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

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
      res.json(issue);
    } catch (err) {
      respondUpstreamError(res, err);
    }
  });

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

type CreateIssueBody = {
  tmdbId: number;
  mediaType: "movie" | "tv";
  issueType: IssueType;
  message: string;
  problemSeason?: number;
  problemEpisode?: number;
};

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

function parseMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" && message.trim() !== ""
    ? message.trim()
    : null;
}

function parseStatus(body: unknown): IssueStatus | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const status = (body as { status?: unknown }).status;
  return status === "open" || status === "resolved" ? status : null;
}

function parseNumericId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return isPositiveInteger(id) ? id : null;
}

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

function requireSession(res: Response): SessionPayload | null {
  const session = res.locals.session as SessionPayload | undefined;
  if (!session) {
    res.status(401).json({ error: "not authenticated" });
    return null;
  }
  return session;
}

function canAccessIssue(
  issue: IssueView,
  session: SessionPayload,
): boolean {
  return (
    issue.createdBy.id === session.seerrUserId ||
    isAdmin(session.permissions)
  );
}

function respondUpstreamError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : "Upstream request failed";
  console.error(message);
  res.status(502).json({ error: message });
}
