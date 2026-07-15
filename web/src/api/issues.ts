import type { MediaType } from "./discover";

export type IssueType = "video" | "audio" | "subtitles" | "other";
export type IssueStatus = "open" | "resolved";

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

export type CreateIssueInput = {
  tmdbId: number;
  mediaType: MediaType;
  issueType: IssueType;
  message: string;
  problemSeason?: number;
  problemEpisode?: number;
};

export type CreateIssueResult =
  | { ok: true; issue: IssueView }
  | { ok: false; notTracked: true };

export async function fetchMyIssues(): Promise<IssueView[]> {
  const res = await fetch("/api/issues");
  if (!res.ok) {
    throw new Error(`Failed to load issues (${res.status})`);
  }
  const body = (await res.json()) as { results: IssueView[] };
  return body.results;
}

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

export function issueStatusLabel(status: IssueStatus): string {
  return status === "open" ? "Open" : "Resolved";
}

export function issueStatusBadgeClass(status: IssueStatus): string {
  return status === "open"
    ? "request-status request-status-processing"
    : "request-status request-status-approved";
}

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
