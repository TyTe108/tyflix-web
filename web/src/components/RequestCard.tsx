import { Link } from "react-router-dom";
import {
  formatRequestDate,
  mediaStatusLabel,
  requestStatusBadgeClass,
  type RequestView,
} from "../api/requests";

export type RequestCardActions = {
  onApprove: () => void;
  onDecline: () => void;
  inFlight: boolean;
  disabled: boolean;
};

export function RequestCard({
  request,
  showRequester = false,
  actions,
}: {
  request: RequestView;
  showRequester?: boolean;
  actions?: RequestCardActions;
}) {
  const to = `/media/${request.mediaType}/${request.tmdbId}`;
  const showActions =
    actions !== undefined && request.requestStatus === "pending";

  return (
    <div className="request-card">
      <Link to={to} className="request-card-poster" aria-label={request.title}>
        {request.posterUrl ? (
          <img src={request.posterUrl} alt="" loading="lazy" />
        ) : (
          <div className="request-card-poster-placeholder" aria-hidden="true">
            No poster
          </div>
        )}
      </Link>

      <div className="request-card-body">
        <div className="request-card-head">
          <Link to={to} className="request-card-title">
            {request.title}
          </Link>
          <span className="stats-tag">
            {request.mediaType === "tv" ? "TV" : "Movie"}
          </span>
          <span className={requestStatusBadgeClass(request.requestStatus)}>
            {request.requestStatus}
          </span>
        </div>

        <div className="request-card-meta muted">
          {showRequester ? (
            <span>Requested by {request.requestedByName}</span>
          ) : null}
          {request.mediaType === "tv" && request.seasons.length > 0 ? (
            <span>Seasons {request.seasons.join(", ")}</span>
          ) : null}
          <span>{mediaStatusLabel(request.mediaStatus)}</span>
          <span>Requested {formatRequestDate(request.createdAt)}</span>
        </div>
      </div>

      {showActions ? (
        <div className="request-card-actions">
          <button
            type="button"
            className="btn"
            disabled={actions.disabled}
            onClick={actions.onApprove}
          >
            {actions.inFlight ? "Working…" : "Approve"}
          </button>
          <button
            type="button"
            className="btn secondary"
            disabled={actions.disabled}
            onClick={actions.onDecline}
          >
            Decline
          </button>
        </div>
      ) : null}
    </div>
  );
}
