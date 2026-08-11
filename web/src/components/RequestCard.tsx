// One row in a list of Seerr requests: poster, title, badges, and, for an
// admin looking at a pending item, Approve and Decline buttons.
//
// Two callers. MyRequestsPage renders it read-only, showing only your own
// requests. AdminPage renders it with `actions` and `showRequester`, so the
// same card doubles as the approval queue.
//
// Everything links back to /media/:type/:tmdbId, since a request is keyed by
// TMDB id whether or not Plex has the title yet.
import { Link } from "react-router";
import {
  formatRequestDate,
  mediaStatusLabel,
  requestStatusBadgeClass,
  type RequestView,
} from "../api/requests";

// Supplying this is what turns a read-only card into an actionable one.
export type RequestCardActions = {
  onApprove: () => void;
  onDecline: () => void;
  /** True while this card's own approve or decline call is out. Drives the button text. */
  inFlight: boolean;
  /** True while any call is out, this card's or another's. Disables both buttons. */
  disabled: boolean;
};

/**
 * Request card.
 *
 * @param showRequester Adds a "Requested by" line. On by the admin queue, off
 * on a user's own list where the answer is always themselves.
 * @param actions Omit for a read-only card. The buttons also need the request
 * to still be pending, so an already-approved row shows no controls even when
 * actions are passed.
 */
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
          {/* Stretched-link: the title keeps its own <Link>, and an absolute
              inset layer expands its hit area over the card. A wrapping <a>
              around the row would nest the Approve/Decline buttons inside an
              anchor (invalid HTML) and steal their clicks. Action controls and
              the poster sit above the stretch with a higher z-index. */}
          <Link to={to} className="request-card-title">
            {request.title}
            <span
              className="request-card-stretch"
              data-testid="request-card-stretch"
              aria-hidden="true"
            />
          </Link>
          <span className="stats-tag">
            {request.mediaType === "tv" ? "TV" : "Movie"}
          </span>
          <span className={requestStatusBadgeClass(request.requestStatus)}>
            {request.requestStatus}
          </span>
        </div>

        {/* Meta line. Each piece is conditional, so the row collapses to
            whatever this particular request actually has. */}
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

      {/* Admin approval controls. Both buttons go dead while any request on the
          page is being acted on, and only this one's label changes. */}
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
