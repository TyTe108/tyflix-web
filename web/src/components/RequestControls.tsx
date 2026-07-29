// The filter and sort bar above a list of Seerr requests: media type, request
// status, sort key, and a direction toggle.
//
// Two pages share it, MyRequestsPage and the requests tab of AdminPage, which
// is the reason it's a component and not inline markup. Both hold the state and
// hand it back through onChange, and both run the actual filtering through
// applyRequestControls in lib/requestControls.ts. Nothing is filtered here.
//
// Not to be confused with the local RequestControls inside MediaDetailPage,
// which is the request form. Same name, unrelated job.
import type {
  RequestControlsState,
  RequestMediaFilter,
  RequestSortKey,
  RequestStatusFilter,
} from "../lib/requestControls";
import { Dropdown } from "./Dropdown";

type RequestControlsProps = {
  /** Fully controlled. The parent owns this and re-renders on every change. */
  value: RequestControlsState;
  /** Fires with a whole new state object, never a partial. */
  onChange: (next: RequestControlsState) => void;
};

const MEDIA_OPTIONS: { value: RequestMediaFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "movie", label: "Movies" },
  { value: "tv", label: "Series" },
];

// One list, two different Seerr fields behind it. Pending, approved, completed
// and failed are states of the request. Processing, available, unavailable and
// deleted describe the media. applyRequestControls sorts out which is which.
const STATUS_OPTIONS: { value: RequestStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "completed", label: "Completed" },
  { value: "processing", label: "Processing" },
  { value: "failed", label: "Failed" },
  { value: "available", label: "Available" },
  { value: "unavailable", label: "Unavailable" },
  { value: "deleted", label: "Deleted" },
];

// "added" sorts on the request's created date, "modified" on its updated date.
const SORT_OPTIONS: { value: RequestSortKey; label: string }[] = [
  { value: "added", label: "Most Recent" },
  { value: "modified", label: "Last Modified" },
];

/**
 * Three dropdowns and a sort-direction arrow. Pure presentation over a state
 * object the parent owns.
 *
 * The Dropdown callbacks hand back a plain string, so each one casts to its
 * union. The option lists are the only source of those values, which is what
 * keeps the cast honest.
 */
export function RequestControls({ value, onChange }: RequestControlsProps) {
  // Direction is a flip rather than a dropdown, since it only has two states.
  const toggleDir = () => {
    onChange({ ...value, dir: value.dir === "asc" ? "desc" : "asc" });
  };

  return (
    <div className="request-filters">
      <label className="request-filter">
        <span>Media</span>
        <Dropdown
          label="Media"
          value={value.media}
          options={MEDIA_OPTIONS}
          onChange={(v) =>
            onChange({ ...value, media: v as RequestMediaFilter })
          }
        />
      </label>

      <label className="request-filter">
        <span>Status</span>
        <Dropdown
          label="Status"
          value={value.status}
          options={STATUS_OPTIONS}
          onChange={(v) =>
            onChange({ ...value, status: v as RequestStatusFilter })
          }
        />
      </label>

      <label className="request-filter">
        <span>Sort</span>
        <Dropdown
          label="Sort"
          value={value.sort}
          options={SORT_OPTIONS}
          onChange={(v) =>
            onChange({ ...value, sort: v as RequestSortKey })
          }
        />
      </label>

      <button
        type="button"
        className="request-filter-dir"
        onClick={toggleDir}
        aria-label={value.dir === "asc" ? "Sort ascending" : "Sort descending"}
      >
        {value.dir === "asc" ? "▲" : "▼"}
      </button>
    </div>
  );
}
