import type { RequestView } from "../api/requests";

export type RequestMediaFilter = "all" | "movie" | "tv";

export type RequestStatusFilter =
  | "all"
  | "pending"
  | "approved"
  | "completed"
  | "processing"
  | "failed"
  | "available"
  | "unavailable"
  | "deleted";

export type RequestSortKey = "added" | "modified";

export type SortDir = "asc" | "desc";

export type RequestControlsState = {
  media: RequestMediaFilter;
  status: RequestStatusFilter;
  sort: RequestSortKey;
  dir: SortDir;
};

export const DEFAULT_REQUEST_CONTROLS: RequestControlsState = {
  media: "all",
  status: "all",
  sort: "added",
  dir: "desc",
};

function matchesStatus(
  request: RequestView,
  status: RequestStatusFilter,
): boolean {
  switch (status) {
    case "all":
      return true;
    case "pending":
      return request.requestStatus === "pending";
    case "approved":
      return request.requestStatus === "approved";
    case "completed":
      return request.requestStatus === "completed";
    case "failed":
      return request.requestStatus === "failed";
    case "processing":
      return request.mediaStatus === "processing";
    case "available":
      return (
        request.mediaStatus === "available" ||
        request.mediaStatus === "partially_available"
      );
    case "unavailable":
      return (
        request.mediaStatus === "unknown" || request.mediaStatus === "pending"
      );
    case "deleted":
      return request.mediaStatus === "deleted";
  }
}

function compareRequests(
  a: RequestView,
  b: RequestView,
  sort: RequestSortKey,
  dir: SortDir,
): number {
  const av = sort === "added" ? a.createdAt : a.updatedAt;
  const bv = sort === "added" ? b.createdAt : b.updatedAt;

  const at = Date.parse(av);
  const bt = Date.parse(bv);

  let cmp: number;
  if (Number.isNaN(at) || Number.isNaN(bt)) {
    cmp = av < bv ? -1 : av > bv ? 1 : 0;
  } else {
    cmp = at - bt;
  }

  return dir === "asc" ? cmp : -cmp;
}

export function applyRequestControls(
  list: RequestView[],
  controls: RequestControlsState,
): RequestView[] {
  const filtered = list.filter((request) => {
    const mediaOk =
      controls.media === "all" || request.mediaType === controls.media;
    return mediaOk && matchesStatus(request, controls.status);
  });

  filtered.sort((a, b) =>
    compareRequests(a, b, controls.sort, controls.dir),
  );

  return filtered;
}
