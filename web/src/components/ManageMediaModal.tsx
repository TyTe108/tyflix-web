// Admin "Manage" slide-over for a title page. Lists that title's Seerr
// requests and offers a destructive whole-title remove through
// DELETE /api/admin/media. Opened from MediaDetailPage's Manage button.
//
// Unchecking the prevent-re-request box means the Seerr media row is deleted
// instead of blocklisted, so the title can be re-requested and Auto-Request
// can pull it back within about three minutes.
import { useEffect, useState, type RefObject } from "react";
import {
  removeMedia,
  type RemoveMediaResult,
} from "../api/admin";
import type { MediaType } from "../api/discover";
import {
  fetchAllRequests,
  type RequestView,
} from "../api/requests";
import { Modal } from "./Modal";

export type ManageMediaModalProps = {
  open: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
};

type RequestsState =
  | { kind: "loading" }
  | { kind: "ready"; requests: RequestView[] }
  | { kind: "error"; message: string };

type RemoveState =
  | { kind: "idle" }
  | { kind: "armed" }
  | { kind: "submitting" }
  | { kind: "done"; result: RemoveMediaResult }
  | { kind: "error"; message: string };

/**
 * Modal content for managing one title: request list plus remove action.
 */
export function ManageMediaModal({
  open,
  onClose,
  returnFocusRef,
  mediaType,
  tmdbId,
  title,
}: ManageMediaModalProps) {
  const [requestsState, setRequestsState] = useState<RequestsState>({
    kind: "loading",
  });
  const [blocklist, setBlocklist] = useState(true);
  const [removeState, setRemoveState] = useState<RemoveState>({ kind: "idle" });

  useEffect(() => {
    if (!open) {
      return;
    }

    setRequestsState({ kind: "loading" });
    setBlocklist(true);
    setRemoveState({ kind: "idle" });

    let cancelled = false;
    // Over-fetches the whole admin request queue and filters client-side.
    // Accepted for now rather than adding a per-title endpoint.
    void fetchAllRequests()
      .then((all) => {
        if (cancelled) {
          return;
        }
        setRequestsState({
          kind: "ready",
          requests: all.filter(
            (request) =>
              request.tmdbId === tmdbId && request.mediaType === mediaType,
          ),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setRequestsState({
          kind: "error",
          message:
            err instanceof Error ? err.message : "Failed to load requests",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [open, mediaType, tmdbId]);

  const removeLabel =
    mediaType === "movie" ? "Remove from Radarr" : "Remove from Sonarr";

  async function confirmRemove() {
    setRemoveState({ kind: "submitting" });
    try {
      const result = await removeMedia(mediaType, tmdbId, { blocklist });
      setRemoveState({ kind: "done", result });
    } catch (err: unknown) {
      setRemoveState({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to remove media",
      });
    }
  }

  function onRemoveClick() {
    if (removeState.kind === "armed") {
      void confirmRemove();
      return;
    }
    if (
      removeState.kind === "idle" ||
      removeState.kind === "error" ||
      removeState.kind === "done"
    ) {
      setRemoveState({ kind: "armed" });
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Manage ${title}`}
      returnFocusRef={returnFocusRef}
    >
      <section
        className="manage-media-section"
        aria-labelledby="manage-media-requests-heading"
      >
        <h3 id="manage-media-requests-heading">Requests</h3>
        {requestsState.kind === "loading" ? (
          <p className="muted">Loading requests…</p>
        ) : null}
        {requestsState.kind === "error" ? (
          <p className="error">{requestsState.message}</p>
        ) : null}
        {requestsState.kind === "ready" && requestsState.requests.length === 0 ? (
          <p className="muted">No requests</p>
        ) : null}
        {requestsState.kind === "ready" && requestsState.requests.length > 0 ? (
          <ul className="manage-media-request-list">
            {requestsState.requests.map((request) => (
              <li key={request.id} className="manage-media-request-row">
                <span className="manage-media-request-name">
                  {request.requestedByName}
                </span>
                <span className="manage-media-request-status">
                  {request.requestStatus}
                </span>
                {mediaType === "tv" && request.seasons.length > 0 ? (
                  <span className="muted manage-media-request-seasons">
                    Seasons {request.seasons.join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section
        className="manage-media-section"
        aria-labelledby="manage-media-actions-heading"
      >
        <h3 id="manage-media-actions-heading">Media</h3>
        <label className="manage-media-blocklist">
          <input
            type="checkbox"
            checked={blocklist}
            disabled={
              removeState.kind === "submitting" || removeState.kind === "done"
            }
            onChange={(event) => {
              setBlocklist(event.target.checked);
              if (removeState.kind === "armed") {
                setRemoveState({ kind: "idle" });
              }
            }}
          />
          <span>
            Prevent this title from being requested again. Uncheck to delete
            the Seerr record instead, which allows re-request and Auto-Request.
          </span>
        </label>

        <button
          type="button"
          className={
            removeState.kind === "armed"
              ? "btn manage-media-confirm"
              : "btn secondary"
          }
          disabled={removeState.kind === "submitting"}
          onClick={onRemoveClick}
        >
          {removeState.kind === "submitting"
            ? "Removing…"
            : removeState.kind === "armed"
              ? "Confirm remove?"
              : removeLabel}
        </button>

        {removeState.kind === "error" ? (
          <p className="error manage-media-result">{removeState.message}</p>
        ) : null}

        {removeState.kind === "done" ? (
          <RemoveResultSummary result={removeState.result} />
        ) : null}
      </section>
    </Modal>
  );
}

function RemoveResultSummary({ result }: { result: RemoveMediaResult }) {
  const declinedCount = result.requestsDeclined.length;
  const partialBlocklistFailure =
    result.status === 500 &&
    result.filesDeleted &&
    result.blocklisted === false;

  return (
    <div className="manage-media-result" role="status">
      {partialBlocklistFailure ? (
        <p className="error">
          The files are gone, but the blocklist did not apply. This title can
          come back on its own.
        </p>
      ) : null}
      <ul className="manage-media-result-list">
        <li>
          Files deleted: {result.filesDeleted ? "yes" : "no"}
        </li>
        <li>
          Blocklisted:{" "}
          {result.blocklisted === null
            ? "n/a"
            : result.blocklisted
              ? "yes"
              : "no"}
        </li>
        {result.mediaRowDeleted !== null ? (
          <li>
            Seerr media row deleted: {result.mediaRowDeleted ? "yes" : "no"}
          </li>
        ) : null}
        <li>
          Requests declined: {declinedCount}
        </li>
      </ul>
      {result.error && !partialBlocklistFailure ? (
        <p className="error">{result.error}</p>
      ) : null}
    </div>
  );
}
