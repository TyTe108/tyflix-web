// Filtering and sorting for a list of requests. Shared by two screens that
// otherwise have nothing in common: MyRequestsPage, where it's your own
// requests, and the requests panel on AdminPage, where it's everybody's. The
// components/RequestControls.tsx toolbar is the UI for it, and this file is the
// logic underneath.
//
// It's all pure and all client-side. Both pages fetch the whole list in one
// call and page through it in the browser via usePagination, so nothing here
// touches the network or the server's query params.
//
// The one genuinely non-obvious thing is that a request has two independent
// statuses, and this single dropdown filters on both. See RequestStatusFilter.

import type { RequestView } from "../api/requests";

export type RequestMediaFilter = "all" | "movie" | "tv";

// One flat list of choices, but the members split across two different fields
// on the request, and the split doesn't follow declaration order. "pending",
// "approved", "completed" and "failed" ask about the approval decision
// (`requestStatus`); "processing", "available", "unavailable" and "deleted" ask
// where the file itself has got to (`mediaStatus`). Nothing in the type says
// which is which, so matchesStatus below is the only place that knows.
//
// They aren't mutually exclusive either. A request can be "approved" and still
// "processing", and picking one of those two shows it either way.
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

// "added" sorts on createdAt, "modified" on updatedAt.
export type RequestSortKey = "added" | "modified";

export type SortDir = "asc" | "desc";

// The whole toolbar as one value. Both pages hold this in a single useState and
// hand it straight to applyRequestControls.
export type RequestControlsState = {
  media: RequestMediaFilter;
  status: RequestStatusFilter;
  sort: RequestSortKey;
  dir: SortDir;
};

/** Newest first, nothing filtered out. What both pages open on. */
export const DEFAULT_REQUEST_CONTROLS: RequestControlsState = {
  media: "all",
  status: "all",
  sort: "added",
  dir: "desc",
};

// Where the two-field split actually happens. The approval cases compare
// against requestStatus, the availability cases against mediaStatus.
//
// Two of these deliberately fold several values into one choice. "available"
// also catches partially_available, since a half-arrived show is still
// something you can go watch. "unavailable" covers both unknown and pending,
// which are the two flavours of nothing-on-disk-yet.
//
// No default arm, so adding a member to RequestStatusFilter surfaces here
// rather than silently filtering everything out.
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

// Compares two requests on the chosen timestamp.
//
// Seerr's dates are ISO strings, so the usual path is parse-then-subtract. If
// either side won't parse, it falls back to comparing the raw strings, which
// for ISO-8601 sorts correctly anyway and at least keeps the order stable
// instead of returning NaN and leaving the sort undefined.
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

/**
 * Filters then sorts a request list according to the toolbar state.
 *
 * Media type and status are ANDed, so picking "Movies" and "Pending" gets you
 * pending movies and nothing else.
 *
 * Returns a new array and never touches the input. That's load-bearing: both
 * callers wrap this in useMemo over the fetched list, and sorting the original
 * in place would mutate the array React is holding as state.
 */
export function applyRequestControls(
  list: RequestView[],
  controls: RequestControlsState,
): RequestView[] {
  // filter() already gave us a fresh array, so the in-place sort below only
  // reorders the copy.
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
