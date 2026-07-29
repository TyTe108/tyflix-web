// Client for the server's issues router (server/src/routes/issues.ts), mounted
// at /api/issues behind requireAuth. This is "report a problem on a title":
// wrong cut, bad audio, missing subtitles, and following it through to
// resolution.
//
// Seerr owns the issue tracker; Tyflix just puts a front end on it. Titles and
// posters get filled in from TMDB server-side, since Seerr's issue rows only
// carry media ids.
//
// Authorization is per-issue rather than per-route. You can read, comment on,
// and change the status of an issue if you filed it or if you're an admin, so
// setIssueStatus is not an admin-only call. Only /all is.
//
// Errors follow the api/discover.ts convention: throw on non-2xx with the
// status code. Two endpoints deviate, and both are documented where they sit.

import type { MediaType } from "./discover";

// Mirrors Seerr's own issue categories. The server maps these to Seerr's
// numeric codes, so the strings can't drift independently.
export type IssueType = "video" | "audio" | "subtitles" | "other";
export type IssueStatus = "open" | "resolved";

// One issue with its whole comment thread. `media.title` and `media.posterUrl`
// are the TMDB enrichment; both stay as Seerr sent them if the lookup missed,
// which is why they're optional and nullable.
export type IssueView = {
  id: number;
  issueType: IssueType;
  status: IssueStatus;
  createdAt: string;
  updatedAt: string;
  media: {
    id: number;
    tmdbId: number;
    mediaType: MediaType;
    title?: string | null;
    posterUrl?: string | null;
  };
  createdBy: {
    id: number;
    displayName: string;
    plexUsername: string;
  };
  comments: Array<{
    id: number;
    message: string;
    createdAt: string;
    user: {
      id: number;
      displayName: string;
    };
  }>;
};

// Body for POST /. Keyed on tmdbId because that's what the browser has; the
// server swaps it for Seerr's internal media id before creating anything.
// Season and episode pin a TV issue to one episode and accept 0.
export type CreateIssueInput = {
  tmdbId: number;
  mediaType: MediaType;
  issueType: IssueType;
  message: string;
  problemSeason?: number;
  problemEpisode?: number;
};

// "notTracked" is the one failure the reporting form has to handle rather than
// throw on: Seerr has no media record for that TMDB id, so there's nothing to
// attach an issue to. It's a real answer, not an error.
export type CreateIssueResult =
  | { ok: true; issue: IssueView }
  | { ok: false; notTracked: true };

/**
 * GET /api/issues. The caller's own issues.
 *
 * Seerr has no per-user issue endpoint, so the server pulls the full list and
 * filters it. Fine at household scale, worth remembering if it ever isn't.
 *
 * @throws Error on any non-2xx.
 */
export async function fetchMyIssues(): Promise<IssueView[]> {
  const res = await fetch("/api/issues");
  if (!res.ok) {
    throw new Error(`Failed to load issues (${res.status})`);
  }
  const body = (await res.json()) as { results: IssueView[] };
  return body.results;
}

/**
 * GET /api/issues/:id. One issue for the detail page.
 *
 * 403 and 404 collapse into a single "not found or you don't have access"
 * message on purpose, so the response can't be used to probe which issue ids
 * exist.
 *
 * @throws Error always on non-2xx. Note that an id Seerr has never seen comes
 * back as a 502 rather than a 404, because the fetch throws before the
 * ownership check runs.
 */
export async function fetchIssue(id: number): Promise<IssueView> {
  const res = await fetch(`/api/issues/${id}`);
  if (res.status === 403 || res.status === 404) {
    throw new Error("Issue not found or you don't have access");
  }
  if (!res.ok) {
    throw new Error(`Failed to load issue (${res.status})`);
  }
  return (await res.json()) as IssueView;
}

/**
 * GET /api/issues/all. Everybody's issues, for the admin queue.
 *
 * @throws Error on any non-2xx, including 403 for a non-admin.
 */
export async function fetchAllIssues(): Promise<IssueView[]> {
  const res = await fetch("/api/issues/all");
  if (!res.ok) {
    throw new Error(`Failed to load issues (${res.status})`);
  }
  const body = (await res.json()) as { results: IssueView[] };
  return body.results;
}

/**
 * POST /api/issues/:id/comment. Adds a comment and returns the updated issue,
 * so the thread can be replaced wholesale rather than appended to.
 *
 * Server-side caveat worth knowing: Seerr attributes the comment to the API
 * key's owner, not to the acting Tyflix user. Issue creation gets attribution
 * right; comments don't yet.
 *
 * @throws Error on any non-2xx, including 403 when the issue isn't yours.
 */
export async function addIssueComment(
  id: number,
  message: string,
): Promise<IssueView> {
  const res = await fetch(`/api/issues/${id}/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    throw new Error(`Failed to add comment (${res.status})`);
  }
  return (await res.json()) as IssueView;
}

/**
 * POST /api/issues/:id/status. Resolves or reopens an issue.
 *
 * Not admin-only. The server runs the same ownership check it uses for reading,
 * so a reporter can close their own issue without anyone else's help.
 *
 * @throws Error on any non-2xx.
 */
export async function setIssueStatus(
  id: number,
  status: IssueStatus,
): Promise<IssueView> {
  const res = await fetch(`/api/issues/${id}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    throw new Error(`Failed to update issue (${res.status})`);
  }
  return (await res.json()) as IssueView;
}

/**
 * POST /api/issues. Opens an issue against a title, attributed to the caller.
 *
 * A 404 isn't treated as a failure here. It means Seerr has no media record for
 * that TMDB id, which the reporting form needs to say out loud ("we don't track
 * this title"), so it comes back as `{ ok: false, notTracked: true }` instead
 * of a throw.
 *
 * @throws Error on any other non-2xx.
 */
export async function createIssue(
  input: CreateIssueInput,
): Promise<CreateIssueResult> {
  const res = await fetch("/api/issues", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 404) {
    return { ok: false, notTracked: true };
  }
  if (!res.ok) {
    throw new Error(`Failed to report issue (${res.status})`);
  }
  return { ok: true, issue: (await res.json()) as IssueView };
}

// ---- Display helpers for the issue list and detail pages ----

/** Capitalised label for an issue category. */
export function issueTypeLabel(issueType: IssueType): string {
  switch (issueType) {
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "subtitles":
      return "Subtitles";
    case "other":
      return "Other";
  }
}

/** "Open" or "Resolved". */
export function issueStatusLabel(status: IssueStatus): string {
  return status === "open" ? "Open" : "Resolved";
}

/**
 * Badge class for an issue's status, borrowed from the request-status palette:
 * open reads as in-progress amber, resolved as green.
 */
export function issueStatusBadgeClass(status: IssueStatus): string {
  return status === "open"
    ? "request-status request-status-processing"
    : "request-status request-status-approved";
}

/**
 * Short localised date from Seerr's ISO timestamp. Same shape and same
 * unparseable-string fallback as formatRequestDate in api/requests.ts.
 */
export function formatIssueDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
