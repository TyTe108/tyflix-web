import type {
  RequestControlsState,
  RequestMediaFilter,
  RequestSortKey,
  RequestStatusFilter,
} from "../lib/requestControls";
import { Dropdown } from "./Dropdown";

type RequestControlsProps = {
  value: RequestControlsState;
  onChange: (next: RequestControlsState) => void;
};

const MEDIA_OPTIONS: { value: RequestMediaFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "movie", label: "Movies" },
  { value: "tv", label: "Series" },
];

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

const SORT_OPTIONS: { value: RequestSortKey; label: string }[] = [
  { value: "added", label: "Most Recent" },
  { value: "modified", label: "Last Modified" },
];

export function RequestControls({ value, onChange }: RequestControlsProps) {
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
