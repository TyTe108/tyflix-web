// Admin "Manage" slide-over for a title page. Lists that title's Seerr
// requests and offers whole-title removal through DELETE /api/admin/media.
// For TV it also shows a Sonarr season/episode tree with per-season and
// per-episode remove. Opened from MediaDetailPage's Manage button.
//
// Unchecking the prevent-re-request box means the Seerr media row is deleted
// instead of blocklisted, so the title can be re-requested and Auto-Request
// can pull it back within about three minutes.
import { useCallback, useEffect, useState, type RefObject } from "react";
import {
  fetchSeasonTree,
  removeEpisode,
  removeMedia,
  removeSeason,
  type AdminEpisodeRemoveResponse,
  type AdminRequestLeftOpen,
  type AdminSeasonRow,
  type AdminSeasonTree,
  type RemoveMediaResult,
  type RemoveSeasonResult,
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

type TreeState =
  | { kind: "loading" }
  | { kind: "ready"; tree: AdminSeasonTree }
  | { kind: "error"; message: string };

type ArmedTarget =
  | { kind: "title" }
  | { kind: "season"; seasonNumber: number }
  | { kind: "episode"; episodeId: number };

type TitleRemoveState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "done"; result: RemoveMediaResult }
  | { kind: "error"; message: string };

type GranularResult =
  | { kind: "season"; result: RemoveSeasonResult }
  | { kind: "episode"; result: AdminEpisodeRemoveResponse }
  | { kind: "error"; message: string };

/**
 * Modal content for managing one title: request list, whole-title remove, and
 * (for TV) a collapsible Sonarr season/episode tree.
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
  const [armed, setArmed] = useState<ArmedTarget | null>(null);
  const [titleRemoveState, setTitleRemoveState] = useState<TitleRemoveState>({
    kind: "idle",
  });
  const [treeState, setTreeState] = useState<TreeState>({ kind: "loading" });
  const [treeReloadKey, setTreeReloadKey] = useState(0);
  const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(
    () => new Set(),
  );
  const [granularBusy, setGranularBusy] = useState(false);
  const [granularResult, setGranularResult] = useState<GranularResult | null>(
    null,
  );

  const anyBusy =
    titleRemoveState.kind === "submitting" || granularBusy;

  const loadTree = useCallback(() => {
    setTreeReloadKey((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    setRequestsState({ kind: "loading" });
    setBlocklist(true);
    setArmed(null);
    setTitleRemoveState({ kind: "idle" });
    setExpandedSeasons(new Set());
    setGranularResult(null);
    setGranularBusy(false);

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

  // TV season tree. Same loading/error/Retry shape as EpisodeBrowser: a
  // reloadKey bump is the Retry input, and cancelled keeps a stale response
  // from painting over the current title.
  useEffect(() => {
    if (!open || mediaType !== "tv") {
      return;
    }

    let cancelled = false;
    setTreeState({ kind: "loading" });

    void fetchSeasonTree(tmdbId)
      .then((tree) => {
        if (cancelled) {
          return;
        }
        setTreeState({ kind: "ready", tree });
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setTreeState({
          kind: "error",
          message:
            err instanceof Error ? err.message : "Failed to load seasons",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [open, mediaType, tmdbId, treeReloadKey]);

  const removeLabel =
    mediaType === "movie" ? "Remove from Radarr" : "Remove from Sonarr";

  function arm(target: ArmedTarget) {
    if (anyBusy) {
      return;
    }
    setArmed(target);
  }

  async function confirmTitleRemove() {
    setArmed(null);
    setTitleRemoveState({ kind: "submitting" });
    try {
      const result = await removeMedia(mediaType, tmdbId, { blocklist });
      setTitleRemoveState({ kind: "done", result });
    } catch (err: unknown) {
      setTitleRemoveState({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to remove media",
      });
    }
  }

  function onTitleRemoveClick() {
    if (armed?.kind === "title") {
      void confirmTitleRemove();
      return;
    }
    arm({ kind: "title" });
  }

  async function confirmSeasonRemove(seasonNumber: number) {
    setArmed(null);
    setGranularBusy(true);
    setGranularResult(null);
    try {
      const result = await removeSeason(tmdbId, seasonNumber);
      setGranularResult({ kind: "season", result });
      // Refetch from Sonarr rather than mutating local state, after every
      // season removal including a partial failure: a partial delete removes
      // some files and leaves others, so the on-screen counts go stale exactly
      // when accurate state matters most.
      loadTree();
    } catch (err: unknown) {
      setGranularResult({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Failed to remove season",
      });
    } finally {
      setGranularBusy(false);
    }
  }

  async function confirmEpisodeRemove(episodeId: number) {
    setArmed(null);
    setGranularBusy(true);
    setGranularResult(null);
    try {
      const result = await removeEpisode(tmdbId, episodeId);
      setGranularResult({ kind: "episode", result });
      loadTree();
    } catch (err: unknown) {
      setGranularResult({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Failed to remove episode",
      });
    } finally {
      setGranularBusy(false);
    }
  }

  function toggleSeason(seasonNumber: number) {
    setExpandedSeasons((prev) => {
      const next = new Set(prev);
      if (next.has(seasonNumber)) {
        next.delete(seasonNumber);
      } else {
        next.add(seasonNumber);
      }
      return next;
    });
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

      {mediaType === "tv" ? (
        <SeasonTreeSection
          treeState={treeState}
          expandedSeasons={expandedSeasons}
          armed={armed}
          busy={anyBusy}
          granularResult={granularResult}
          onRetry={loadTree}
          onToggleSeason={toggleSeason}
          onArmSeason={(seasonNumber) => arm({ kind: "season", seasonNumber })}
          onConfirmSeason={(seasonNumber) => {
            void confirmSeasonRemove(seasonNumber);
          }}
          onArmEpisode={(episodeId) => arm({ kind: "episode", episodeId })}
          onConfirmEpisode={(episodeId) => {
            void confirmEpisodeRemove(episodeId);
          }}
        />
      ) : null}

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
              titleRemoveState.kind === "submitting" ||
              titleRemoveState.kind === "done" ||
              granularBusy
            }
            onChange={(event) => {
              setBlocklist(event.target.checked);
              if (armed?.kind === "title") {
                setArmed(null);
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
            armed?.kind === "title"
              ? "btn manage-media-confirm"
              : "btn secondary"
          }
          disabled={anyBusy}
          onClick={onTitleRemoveClick}
        >
          {titleRemoveState.kind === "submitting"
            ? "Removing…"
            : armed?.kind === "title"
              ? "Confirm remove?"
              : removeLabel}
        </button>

        {titleRemoveState.kind === "error" ? (
          <p className="error manage-media-result">{titleRemoveState.message}</p>
        ) : null}

        {titleRemoveState.kind === "done" ? (
          <RemoveResultSummary result={titleRemoveState.result} />
        ) : null}
      </section>
    </Modal>
  );
}

function SeasonTreeSection({
  treeState,
  expandedSeasons,
  armed,
  busy,
  granularResult,
  onRetry,
  onToggleSeason,
  onArmSeason,
  onConfirmSeason,
  onArmEpisode,
  onConfirmEpisode,
}: {
  treeState: TreeState;
  expandedSeasons: ReadonlySet<number>;
  armed: ArmedTarget | null;
  busy: boolean;
  granularResult: GranularResult | null;
  onRetry: () => void;
  onToggleSeason: (seasonNumber: number) => void;
  onArmSeason: (seasonNumber: number) => void;
  onConfirmSeason: (seasonNumber: number) => void;
  onArmEpisode: (episodeId: number) => void;
  onConfirmEpisode: (episodeId: number) => void;
}) {
  return (
    <section
      className="manage-media-section"
      aria-labelledby="manage-media-seasons-heading"
    >
      <h3 id="manage-media-seasons-heading">Seasons</h3>

      {treeState.kind === "loading" ? (
        <p className="muted">Loading seasons…</p>
      ) : null}

      {treeState.kind === "error" ? (
        <div className="stats-error">
          <p className="error">{treeState.message}</p>
          <button type="button" className="btn secondary" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}

      {treeState.kind === "ready" && treeState.tree.seasons.length === 0 ? (
        <p className="muted">No seasons in Sonarr.</p>
      ) : null}

      {treeState.kind === "ready" && treeState.tree.seasons.length > 0 ? (
        <ul className="manage-media-season-list">
          {treeState.tree.seasons.map((season) => (
            <SeasonRow
              key={season.seasonNumber}
              season={season}
              expanded={expandedSeasons.has(season.seasonNumber)}
              armed={armed}
              busy={busy}
              onToggle={() => onToggleSeason(season.seasonNumber)}
              onArmSeason={() => onArmSeason(season.seasonNumber)}
              onConfirmSeason={() => onConfirmSeason(season.seasonNumber)}
              onArmEpisode={onArmEpisode}
              onConfirmEpisode={onConfirmEpisode}
            />
          ))}
        </ul>
      ) : null}

      {granularResult !== null ? (
        <GranularResultSummary result={granularResult} />
      ) : null}
    </section>
  );
}

function SeasonRow({
  season,
  expanded,
  armed,
  busy,
  onToggle,
  onArmSeason,
  onConfirmSeason,
  onArmEpisode,
  onConfirmEpisode,
}: {
  season: AdminSeasonRow;
  expanded: boolean;
  armed: ArmedTarget | null;
  busy: boolean;
  onToggle: () => void;
  onArmSeason: () => void;
  onConfirmSeason: () => void;
  onArmEpisode: (episodeId: number) => void;
  onConfirmEpisode: (episodeId: number) => void;
}) {
  const seasonArmed =
    armed?.kind === "season" && armed.seasonNumber === season.seasonNumber;
  const label =
    season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`;
  const sizeLabel = formatSizeOnDisk(season.sizeOnDisk);
  const monitoredLabel = season.monitored ? "monitored" : "unmonitored";
  // Full spoken name so assistive tech hears the same meta as the visible
  // spans. Must stay in sync with that text; without it the toggle and the
  // Remove button collide on a bare "Season N" accessible name.
  const toggleName = `${label}, ${season.episodeFileCount} of ${season.episodeCount} files, ${sizeLabel}, ${monitoredLabel}`;

  return (
    <li className="manage-media-season">
      <div className="manage-media-season-row">
        <button
          type="button"
          className="manage-media-season-toggle"
          aria-expanded={expanded}
          aria-label={toggleName}
          onClick={onToggle}
        >
          <span className="manage-media-season-label">{label}</span>
          <span className="muted manage-media-season-meta">
            {season.episodeFileCount}/{season.episodeCount} files
            {" · "}
            {sizeLabel}
            {" · "}
            {monitoredLabel}
          </span>
        </button>
        <button
          type="button"
          className={
            seasonArmed ? "btn manage-media-confirm" : "btn secondary"
          }
          disabled={busy}
          aria-label={
            seasonArmed
              ? `Confirm remove season ${season.seasonNumber}`
              : `Remove season ${season.seasonNumber}`
          }
          onClick={() => {
            if (seasonArmed) {
              onConfirmSeason();
            } else {
              onArmSeason();
            }
          }}
        >
          {seasonArmed
            ? "Confirm remove?"
            : `Remove ${season.seasonNumber === 0 ? "specials" : `season ${season.seasonNumber}`}`}
        </button>
      </div>

      {expanded ? (
        <ul className="manage-media-episode-list">
          {season.episodes.map((episode) => {
            const episodeArmed =
              armed?.kind === "episode" && armed.episodeId === episode.id;
            return (
              <li
                key={episode.id}
                className={
                  episode.hasFile
                    ? "manage-media-episode"
                    : "manage-media-episode manage-media-episode-nofile"
                }
              >
                <div className="manage-media-episode-info">
                  <span className="manage-media-episode-number">
                    E{episode.episodeNumber}
                  </span>
                  <span className="manage-media-episode-title">
                    {episode.title}
                  </span>
                  <span className="muted">
                    {episode.hasFile ? "On disk" : "No file"}
                  </span>
                </div>
                <button
                  type="button"
                  className={
                    episodeArmed
                      ? "btn manage-media-confirm"
                      : "btn secondary"
                  }
                  disabled={busy || !episode.hasFile}
                  aria-label={
                    episodeArmed
                      ? `Confirm remove episode ${episode.episodeNumber}`
                      : `Remove episode ${episode.episodeNumber}`
                  }
                  onClick={() => {
                    if (episodeArmed) {
                      onConfirmEpisode(episode.id);
                    } else {
                      onArmEpisode(episode.id);
                    }
                  }}
                >
                  {episodeArmed ? "Confirm remove?" : "Remove"}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

function GranularResultSummary({ result }: { result: GranularResult }) {
  if (result.kind === "error") {
    return <p className="error manage-media-result">{result.message}</p>;
  }

  if (result.kind === "episode") {
    return (
      <div className="manage-media-result" role="status">
        <ul className="manage-media-result-list">
          <li>
            Episode unmonitored
            {result.result.fileDeleted ? "; file deleted" : "; no file on disk"}
          </li>
        </ul>
        <RequestsLeftOpenNote requests={result.result.requestsLeftOpen} />
      </div>
    );
  }

  const { result: seasonResult } = result;
  const partialFailure =
    seasonResult.status === 500 ||
    seasonResult.filesFailedToDelete.length > 0;

  return (
    <div className="manage-media-result" role="status">
      {partialFailure ? (
        <p className="error">
          Partial failure removing season {seasonResult.seasonNumber}:{" "}
          {seasonResult.filesDeleted.length} file
          {seasonResult.filesDeleted.length === 1 ? "" : "s"} deleted
          {seasonResult.filesFailedToDelete.length > 0
            ? `, ${seasonResult.filesFailedToDelete.length} failed to delete (${seasonResult.filesFailedToDelete
                .map((f) => f.fileId)
                .join(", ")})`
            : ""}
          .
        </p>
      ) : (
        <ul className="manage-media-result-list">
          <li>
            Season {seasonResult.seasonNumber} unmonitored;{" "}
            {seasonResult.filesDeleted.length} file
            {seasonResult.filesDeleted.length === 1 ? "" : "s"} deleted
          </li>
          {seasonResult.requestsDeclined.length > 0 ? (
            <li>
              Requests declined: {seasonResult.requestsDeclined.length}
            </li>
          ) : null}
        </ul>
      )}
      <RequestsLeftOpenNote requests={seasonResult.requestsLeftOpen} />
    </div>
  );
}

function RequestsLeftOpenNote({
  requests,
}: {
  requests: AdminRequestLeftOpen[];
}) {
  if (requests.length === 0) {
    return null;
  }

  // Explanatory, not an error: Seerr has no partial decline, so leaving a
  // multi-season request open after removing one season is the correct
  // behaviour. Naming the covered seasons lets the admin see why.
  return (
    <div className="manage-media-left-open">
      {requests.map((request) => (
        <p key={request.id}>
          Request {request.id} was not declined because Seerr can only decline
          a whole request, and that request also covers seasons{" "}
          {request.seasons.join(", ")}, which are still on the server.
        </p>
      ))}
    </div>
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

function formatSizeOnDisk(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  if (bytes >= gib) {
    return `${(bytes / gib).toFixed(1)} GB`;
  }
  if (bytes >= mib) {
    return `${Math.round(bytes / mib)} MB`;
  }
  return `${bytes} B`;
}
