import type {
  RequestControlsState,
  RequestMediaFilter,
  RequestSortKey,
  RequestStatusFilter,
} from "../lib/requestControls";

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
    <div className="request-controls">
      <label className="request-control">
        <span>Media</span>
        <select
          aria-label="Filter by media type"
          value={value.media}
          onChange={(event) =>
            onChange({
              ...value,
              media: event.target.value as RequestMediaFilter,
            })
          }
        >
          {MEDIA_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="request-control">
        <span>Status</span>
        <select
          aria-label="Filter by status"
          value={value.status}
          onChange={(event) =>
            onChange({
              ...value,
              status: event.target.value as RequestStatusFilter,
            })
          }
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="request-control">
        <span>Sort</span>
        <select
          aria-label="Sort by"
          value={value.sort}
          onChange={(event) =>
            onChange({
              ...value,
              sort: event.target.value as RequestSortKey,
            })
          }
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        className="request-control-dir"
        onClick={toggleDir}
        aria-label={value.dir === "asc" ? "Sort ascending" : "Sort descending"}
      >
        {value.dir === "asc" ? "▲" : "▼"}
      </button>
    </div>
  );
}
