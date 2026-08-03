// The title page: hero art, overview, cast and crew, availability, and one
// primary button that's either Play or Request depending on what the server
// already has. Rendered at /media/:type/:id by App.tsx, inside ProtectedRoute
// and AppShell, where :type is "movie" or "tv" and :id is a TMDB id. Nearly
// every poster in the app links here.
//
// Six endpoints across three API modules. api/discover.ts supplies the detail
// (/api/discover/movie/:id or /tv/:id), the credits and the recommendations.
// api/requests.ts handles POST /api/requests and, for admins, the quality
// profile list. api/issues.ts handles POST /api/issues. EpisodeBrowser fetches
// its own episodes on top of that.
//
// Everything on this page hangs off `mediaStatus`, which is Seerr's answer to
// "is this on the server". That field is the TMDB-to-Plex join in one value:
// available or partially available means Play, anything else means Request,
// and null means Seerr has never heard of the title, which is why the issue
// reporter hides in that case. Nothing here guesses by title.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  fetchCredits,
  fetchMovie,
  fetchRecommendations,
  fetchTv,
  formatRuntime,
  canRequest,
  mediaStatusBadgeClass,
  type CastCredit,
  type CrewCredit,
  type MediaSummary,
  type MediaType,
  type MovieDetail,
  type TvDetail,
} from "../api/discover";
import {
  createIssue,
  type IssueType,
} from "../api/issues";
import { Dropdown } from "../components/Dropdown";
import { ManageMediaModal } from "../components/ManageMediaModal";
import {
  createRequest,
  fetchRequestProfiles,
  mediaStatusLabel,
  type RequestProfiles,
} from "../api/requests";
import { useAuth } from "../auth/AuthContext";
import { EpisodeBrowser } from "../components/EpisodeBrowser";
import { MediaCard } from "../components/MediaCard";
type LoadStatus = "loading" | "ready" | "error";
// The two detail shapes differ enough to be worth discriminating on
// `mediaType` rather than flattening. Movies have runtime and a collection,
// shows have a season list and a tvdbId.
type MediaDetail = MovieDetail | TvDetail;
// Credits tagged with the title they belong to, so a click from one title to
// another doesn't briefly show the previous cast under the new name.
type LoadedCredits = {
  mediaType: MediaType;
  tmdbId: number;
  cast: CastCredit[];
  crew: CrewCredit[];
};
// "already" is its own outcome, not an error. createRequest turns Seerr's 409
// into a result rather than a throw, because someone else asking first isn't a
// failure the user needs to do anything about.
type RequestUiState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "requested" }
  | { kind: "already" }
  | { kind: "error"; message: string };
type IssueUiState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "submitted" }
  | { kind: "error"; message: string };

// Both parsers return null on anything unexpected, which routes the page to
// its error state instead of firing a request that can only 404.
function parseType(raw: string | undefined): "movie" | "tv" | null {
  if (raw === "movie" || raw === "tv") {
    return raw;
  }
  return null;
}

function parseId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

// Defined once at module scope since it never changes and both back controls
// below use it.
const backIcon = (
  <svg
    aria-hidden="true"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M10 3 5 8l5 5" />
  </svg>
);

/**
 * Detail page for one TMDB title.
 *
 * Only owns the detail fetch and the three load states. Everything else, the
 * credits, recommendations, request flow and issue reporter, lives in child
 * components below so a failure in any of them can't take the page down.
 */
export function MediaDetailPage() {
  const params = useParams<{ type: string; id: string }>();
  const mediaType = parseType(params.type);
  const id = parseId(params.id);
  const navigate = useNavigate();
  const location = useLocation();
  // react-router stamps location.key "default" on a first entry, meaning the
  // user landed here directly and there's no history to pop. Going back in
  // that case would leave the app, so it falls back to a link home.
  const canGoBack = location.key !== "default";
  const backControl = canGoBack ? (
    <button
      type="button"
      className="back-link"
      onClick={() => navigate(-1)}
    >
      {backIcon}
      Back
    </button>
  ) : (
    <Link className="back-link" to="/">
      {backIcon}
      Back
    </Link>
  );

  const [detail, setDetail] = useState<MediaDetail | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  // Owns the detail fetch. Re-runs when either route param changes or on
  // retry. Movies and shows are separate TMDB endpoints, so the type in the
  // URL picks which one before anything else happens.
  useEffect(() => {
    if (mediaType === null || id === null) {
      setDetail(null);
      setStatus("error");
      setError("Invalid media link.");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);

    const load =
      mediaType === "movie" ? fetchMovie(id) : fetchTv(id);

    void load
      .then((data) => {
        if (cancelled) {
          return;
        }
        setDetail(data);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setDetail(null);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load media details",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [mediaType, id, reloadKey]);

  return (
    <main className="page page-wide">
      <header className="row">{backControl}</header>

      {status === "loading" ? (
        <p className="muted">Loading…</p>
      ) : null}

      {/* Retry only helps if the params were valid and the request failed. A
          malformed URL gets the back control again instead. */}
      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load details"}</p>
          {mediaType !== null && id !== null ? (
            <button type="button" className="btn secondary" onClick={retry}>
              Retry
            </button>
          ) : (
            backControl
          )}
        </div>
      ) : null}

      {status === "ready" && detail !== null ? (
        <DetailBody detail={detail} />
      ) : null}
    </main>
  );
}

// Everything below the fold once the detail has loaded. Split out from the
// parent so credits and recommendations can load on their own clock without
// the page sitting in a loading state waiting for them.
function DetailBody({ detail }: { detail: MediaDetail }) {
  // Wide backdrop for the hero, poster as the fallback, placeholder if TMDB
  // has neither.
  const heroUrl = detail.backdropUrl ?? detail.posterUrl;
  const yearLabel = detail.year !== null ? ` (${detail.year})` : "";
  const [recommendations, setRecommendations] = useState<MediaSummary[]>([]);
  const [credits, setCredits] = useState<LoadedCredits | null>(null);
  // Only use credits that belong to the title on screen. Navigating between
  // two titles keeps this component mounted, so the old cast would otherwise
  // linger for a frame under the new name.
  const currentCredits =
    credits?.mediaType === detail.mediaType &&
    credits.tmdbId === detail.tmdbId
      ? credits
      : null;

  // Recommendations. Optional content, so a failure clears the list and the
  // section simply doesn't render. Nothing about it is surfaced to the user.
  useEffect(() => {
    let cancelled = false;
    setRecommendations([]);

    void fetchRecommendations(detail.mediaType, detail.tmdbId)
      .then((items) => {
        if (!cancelled) {
          setRecommendations(items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecommendations([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [detail.mediaType, detail.tmdbId]);

  // Cast and crew, one call feeding two separate regions: the "Directed by"
  // line up top and the cast strip further down. Same failure treatment as
  // recommendations, both blocks just disappear.
  useEffect(() => {
    let cancelled = false;
    setCredits(null);

    void fetchCredits(detail.mediaType, detail.tmdbId)
      .then(({ cast, crew }) => {
        if (!cancelled) {
          setCredits({
            mediaType: detail.mediaType,
            tmdbId: detail.tmdbId,
            cast,
            crew,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCredits(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [detail.mediaType, detail.tmdbId]);

  return (
    <article className="media-detail">
      <div className="media-detail-hero">
        {heroUrl ? (
          <img src={heroUrl} alt="" className="media-detail-hero-img" />
        ) : (
          <div className="media-detail-hero-placeholder" aria-hidden="true">
            No image
          </div>
        )}
      </div>

      {/* Tag row. Three separate things that read as one line: media type,
          TMDB's production status ("Released", "Returning Series"), and
          Seerr's availability. The last one is the only one that means
          anything about this server. */}
      <div className="media-detail-meta">
        <p className="media-detail-tag-row">
          <span className="stats-tag">
            {detail.mediaType === "tv" ? "TV" : "Movie"}
          </span>
          {detail.status ? (
            <span className="muted media-detail-status">{detail.status}</span>
          ) : null}
          {detail.mediaStatus !== null ? (
            <span className={mediaStatusBadgeClass(detail.mediaStatus)}>
              {mediaStatusLabel(detail.mediaStatus)}
            </span>
          ) : null}
        </p>

        <h1>
          {detail.title}
          <span className="media-detail-year">{yearLabel}</span>
        </h1>

        {currentCredits !== null && currentCredits.crew.length > 0 ? (
          <CrewSummary crew={currentCredits.crew} />
        ) : null}

        {detail.mediaType === "movie" && detail.collection !== null ? (
          <p className="media-detail-collection">
            <Link to={`/collection/${detail.collection.id}`}>
              Part of the {detail.collection.name}
            </Link>
          </p>
        ) : null}

        {detail.genres.length > 0 ? (
          <p className="media-detail-genres muted">
            {detail.genres.join(" · ")}
          </p>
        ) : null}

        {detail.mediaType === "movie" && detail.runtime !== null ? (
          <p className="media-detail-runtime muted">
            {formatRuntime(detail.runtime)}
          </p>
        ) : null}

        {detail.overview ? (
          <p className="media-detail-overview">{detail.overview}</p>
        ) : (
          <p className="muted">No overview available.</p>
        )}

        {/* The primary button, movie case. Play appears only once Seerr says
            the file is there, and the link is keyed by TMDB id because
            WatchPage does the TMDB-to-Plex resolution itself. Shows get the
            equivalent through EpisodeBrowser further down, since there's no
            single thing to play. */}
        {detail.mediaType === "movie" &&
        (detail.mediaStatus === "available" ||
          detail.mediaStatus === "partially_available") ? (
          <p className="media-detail-play">
            <Link className="btn" to={`/watch/movie/${detail.tmdbId}`}>
              ▶ Play
            </Link>
          </p>
        ) : null}

        {/* Admin-only Manage entry. Calls useAuth itself, same shape as
            ReportIssueControls further down. */}
        <ManageMediaControls detail={detail} />

        {/* The other half of the primary action. RequestControls decides for
            itself whether to render a button or just a status badge. Note
            this is the local component further down this file, not the
            filter bar of the same name in components/. */}
        <RequestControls detail={detail} />

        {/* A null mediaStatus means Seerr has no record of this title, and an
            issue has to attach to a Seerr media row, so the reporter is
            hidden rather than offered and then rejected. */}
        {detail.mediaStatus !== null ? (
          <ReportIssueControls detail={detail} />
        ) : null}

        {/* Cast strip. Each card links to /person/:id, and a missing headshot
            falls back to the actor's initial. */}
        {currentCredits !== null && currentCredits.cast.length > 0 ? (
          <section
            className="media-detail-cast"
            aria-labelledby="cast-heading"
          >
            <h2 id="cast-heading">Cast</h2>
            <ul className="media-cast-list">
              {currentCredits.cast.map((person) => (
                <li key={person.id}>
                  <Link
                    className="media-cast-card"
                    to={`/person/${person.id}`}
                  >
                    {person.profileUrl !== null ? (
                      <img
                        className="media-cast-photo"
                        src={person.profileUrl}
                        alt=""
                      />
                    ) : (
                      <div
                        className="media-cast-photo media-cast-placeholder"
                        aria-hidden="true"
                      >
                        {person.name.slice(0, 1)}
                      </div>
                    )}
                    <span className="media-cast-name">{person.name}</span>
                    {person.character ? (
                      <span className="media-cast-character muted">
                        {person.character}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Two mutually exclusive season blocks, and the split is the whole
            TMDB-versus-Plex distinction in one place. A show that's on the
            server gets EpisodeBrowser, which lists the episodes Plex actually
            holds with real Play links. A show that isn't gets TMDB's season
            summary, which is just names and counts with nothing to click. */}
        {detail.mediaType === "tv" &&
        (detail.mediaStatus === "available" ||
          detail.mediaStatus === "partially_available") ? (
          <EpisodeBrowser tmdbId={detail.tmdbId} />
        ) : null}

        {detail.mediaType === "tv" &&
        detail.mediaStatus !== "available" &&
        detail.mediaStatus !== "partially_available" ? (
          <section
            className="media-detail-seasons"
            aria-labelledby="seasons-heading"
          >
            <h2 id="seasons-heading">Seasons</h2>
            {detail.seasons.length === 0 ? (
              <p className="muted">No seasons listed.</p>
            ) : (
              <ul className="media-season-list">
                {detail.seasons.map((season) => (
                  <li key={season.seasonNumber}>
                    <span className="media-season-name">{season.name}</span>
                    <span className="muted">
                      {season.episodeCount} episode
                      {season.episodeCount === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {/* "More like this". These carry their own availability from Seerr,
            so the status corners here are as accurate as the ones on
            Discover. */}
        {recommendations.length > 0 ? (
          <section
            className="media-detail-recommendations"
            aria-labelledby="recommendations-heading"
          >
            <h2 id="recommendations-heading">More like this</h2>
            <ul className="media-grid">
              {recommendations.map((item) => (
                <li key={`${item.mediaType}:${item.tmdbId}`}>
                  <MediaCard item={item} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </article>
  );
}

// Condenses a full crew list into the one "Directed by X · Written by Y" line
// under the title. Group order here is the display order, and only groups with
// somebody in them survive, so a movie with no credited creator doesn't leave
// a gap.
function CrewSummary({ crew }: { crew: CrewCredit[] }) {
  const groups = [
    { jobs: ["Director"], label: "Directed by" },
    { jobs: ["Creator"], label: "Created by" },
    { jobs: ["Screenplay", "Writer"], label: "Written by" },
    { jobs: ["Executive Producer"], label: "Executive producers" },
    { jobs: ["Producer"], label: "Producers" },
  ];
  const parts = groups.flatMap(({ jobs, label }) => {
    // One person can hold several jobs, and those arrive from TMDB collapsed
    // into a single slash-separated string. Splitting on " / " is what lets a
    // "Screenplay / Director" credit land in both buckets.
    const names = crew
      .filter((person) =>
        person.job.split(" / ").some((job) => jobs.includes(job)),
      )
      .map((person) => person.name);
    return names.length > 0 ? [`${label} ${names.join(", ")}`] : [];
  });

  return parts.length > 0 ? (
    <p className="media-detail-crew muted">{parts.join(" · ")}</p>
  ) : null;
}

// Admin-only Manage button for the primary-action block. Renders nothing for
// non-admins: no disabled control and no placeholder. Owns the modal open
// state and the focus-return ref so DetailBody stays free of useAuth.
function ManageMediaControls({ detail }: { detail: MediaDetail }) {
  const { isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!isAdmin) {
    return null;
  }

  return (
    <p className="media-detail-manage">
      <button
        ref={triggerRef}
        type="button"
        className="btn secondary"
        onClick={() => setOpen(true)}
      >
        Manage
      </button>
      <ManageMediaModal
        open={open}
        onClose={() => setOpen(false)}
        returnFocusRef={triggerRef}
        mediaType={detail.mediaType}
        tmdbId={detail.tmdbId}
        title={detail.title}
      />
    </p>
  );
}

// "Report an issue": collapsed to a button until clicked, then a type picker
// and a description box. The report lands in Seerr and shows up on
// MyIssuesPage, where it can be followed through to resolution.
//
// The caller already hides this for titles Seerr doesn't track, so the
// not-tracked branch below shouldn't normally fire. It's there because the
// server can still answer 404 and that's not an error worth showing raw.
function ReportIssueControls({ detail }: { detail: MediaDetail }) {
  const [expanded, setExpanded] = useState(false);
  const [issueType, setIssueType] = useState<IssueType>("video");
  const [message, setMessage] = useState("");
  const [issueState, setIssueState] = useState<IssueUiState>({ kind: "idle" });

  // Files the issue. createIssue turns a 404 into `ok: false` rather than
  // throwing, so an untracked title is a normal outcome to be phrased for a
  // user, and only real transport or server failures reach the catch.
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIssueState({ kind: "submitting" });
    try {
      const result = await createIssue({
        tmdbId: detail.tmdbId,
        mediaType: detail.mediaType,
        issueType,
        message,
      });
      if (result.ok) {
        setIssueState({ kind: "submitted" });
      } else {
        setIssueState({
          kind: "error",
          message: "This title is not tracked in Seerr.",
        });
      }
    } catch (err: unknown) {
      setIssueState({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Failed to report issue",
      });
    }
  }

  return (
    <section className="issue-report" aria-labelledby="issue-report-heading">
      <h2 id="issue-report-heading">Report an issue</h2>
      {/* Three states in one chain: collapsed, the form, or the thank-you.
          Submitting is one-way, there's no path back to the form once it
          succeeds. Reloading the page is the only way to file a second
          report on the same title. */}
      {!expanded ? (
        <button
          type="button"
          className="btn secondary"
          onClick={() => setExpanded(true)}
        >
          Report an issue
        </button>
      ) : issueState.kind === "submitted" ? (
        <p className="issue-report-success">Issue reported — thanks</p>
      ) : (
        <form
          className="issue-report-form"
          onSubmit={(event) => void submit(event)}
        >
          <label>
            <span>Issue type</span>
            <Dropdown
              label="Issue type"
              value={issueType}
              options={[
                { value: "video", label: "Video" },
                { value: "audio", label: "Audio" },
                { value: "subtitles", label: "Subtitles" },
                { value: "other", label: "Other" },
              ]}
              onChange={(v) => setIssueType(v as IssueType)}
              disabled={issueState.kind === "submitting"}
            />
          </label>
          <label>
            <span>What’s wrong?</span>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              required
              rows={4}
              disabled={issueState.kind === "submitting"}
            />
          </label>
          <button
            type="submit"
            className="btn"
            disabled={issueState.kind === "submitting"}
          >
            {issueState.kind === "submitting" ? "Reporting…" : "Submit report"}
          </button>
          {issueState.kind === "error" ? (
            <p className="error issue-report-error">{issueState.message}</p>
          ) : null}
        </form>
      )}
    </section>
  );
}

// The Request half of the primary action. Renders one of three things: a plain
// status badge when there's nothing to ask for, a single Request button for a
// movie, or a season checklist for a show.
//
// Name collision worth flagging: components/RequestControls.tsx is a different
// thing entirely, the filter bar on MyRequestsPage. This one isn't imported
// anywhere else.
//
// Requests go to Seerr, which hands them to Radarr or Sonarr. Tyflix doesn't
// run any of that pipeline itself.
function RequestControls({ detail }: { detail: MediaDetail }) {
  const { isAdmin } = useAuth();
  const [requestState, setRequestState] = useState<RequestUiState>({
    kind: "idle",
  });
  const [selectedSeasons, setSelectedSeasons] = useState<number[]>([]);
  const [requestProfiles, setRequestProfiles] =
    useState<RequestProfiles | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<
    number | undefined
  >(undefined);

  // "already" and "requested" both mean stop offering the button, so they
  // collapse into one flag for the render.
  const done =
    requestState.kind === "requested" || requestState.kind === "already";
  const submitting = requestState.kind === "submitting";

  // Quality profiles, admin only. The server rejects a profileId from a
  // non-admin with a 403, so there's no point fetching the list for one. Also
  // skipped when the title can't be requested anyway. Clearing both pieces of
  // state up front is what stops a profile from a previous title leaking into
  // the next request.
  useEffect(() => {
    setRequestProfiles(null);
    setSelectedProfileId(undefined);
    if (!isAdmin || !canRequest(detail.mediaStatus)) {
      return;
    }

    let cancelled = false;
    void fetchRequestProfiles(detail.mediaType)
      .then((value) => {
        if (!cancelled) {
          setRequestProfiles(value);
          setSelectedProfileId(value.defaultProfileId);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRequestProfiles(null);
          setSelectedProfileId(undefined);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [detail.mediaStatus, detail.mediaType, isAdmin]);

  /**
   * Creates the request. Shared by the movie button and the season button.
   *
   * Omitting `seasons` entirely is meaningful: the server reads that as the
   * whole show. Movies pass nothing, shows always pass an explicit list.
   * `profileId` is only ever set for admins, since the fetch above is gated.
   */
  const submit = useCallback(
    async (seasons?: number[]) => {
      setRequestState({ kind: "submitting" });
      try {
        const result = await createRequest({
          tmdbId: detail.tmdbId,
          mediaType: detail.mediaType,
          ...(seasons !== undefined ? { seasons } : {}),
          ...(selectedProfileId === undefined
            ? {}
            : { profileId: selectedProfileId }),
        });
        if (result.ok) {
          setRequestState({ kind: "requested" });
        } else {
          setRequestState({ kind: "already" });
        }
      } catch (err: unknown) {
        setRequestState({
          kind: "error",
          message:
            err instanceof Error ? err.message : "Failed to create request",
        });
      }
    },
    [detail.mediaType, detail.tmdbId, selectedProfileId],
  );

  // Season checkbox toggle. Kept sorted so the list sent to Seerr is in season
  // order regardless of the order the boxes were ticked.
  function toggleSeason(seasonNumber: number) {
    setSelectedSeasons((prev) =>
      prev.includes(seasonNumber)
        ? prev.filter((n) => n !== seasonNumber)
        : [...prev, seasonNumber].sort((a, b) => a - b),
    );
  }

  // Nothing to request. canRequest treats available, processing and pending as
  // "already handled", so the three collapse into two labels here: Available
  // if it's on the server, Requested if it's still on its way.
  if (!canRequest(detail.mediaStatus)) {
    const label = detail.mediaStatus === "available" ? "Available" : "Requested";
    return (
      <section className="request-controls" aria-label="Request status">
        <p className="request-controls-status">
          <span className={mediaStatusBadgeClass(detail.mediaStatus)}>
            {label}
          </span>
        </p>
      </section>
    );
  }

  // Partially available is the one status that's both playable and still worth
  // requesting, typically a show with some seasons missing. It gets a line of
  // explanation above whichever request control follows.
  const partialAvailabilityContext =
    detail.mediaStatus === "partially_available" ? (
      <p className="request-controls-status">
        Partially available — request more
      </p>
    ) : null;

  // Built once and dropped into both the movie and the TV branch below.
  // requestProfiles stays null for non-admins and after a failed fetch, so
  // this is null for them and the request just uses Seerr's default profile.
  const qualityProfilePicker =
    requestProfiles && requestProfiles.profiles.length > 0 ? (
      <label className="request-profile-picker">
        <span>Quality profile</span>
        <Dropdown
          label="Quality profile"
          value={String(
            selectedProfileId ?? requestProfiles.profiles[0]?.id ?? "",
          )}
          options={requestProfiles.profiles.map((profile) => ({
            value: String(profile.id),
            label: profile.name,
          }))}
          onChange={(v) => setSelectedProfileId(Number(v))}
          disabled={submitting}
        />
      </label>
    ) : null;

  // Movie branch. One button, nothing to choose, and calling submit with no
  // argument is what tells the server there are no seasons involved.
  if (detail.mediaType === "movie") {
    return (
      <section className="request-controls" aria-label="Request movie">
        {partialAvailabilityContext}
        {done ? (
          <p className="request-controls-status">
            {requestState.kind === "already"
              ? "Already requested"
              : "Requested"}
          </p>
        ) : (
          <>
            {qualityProfilePicker}
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={() => void submit()}
            >
              {submitting ? "Requesting…" : "Request"}
            </button>
          </>
        )}
        {requestState.kind === "error" ? (
          <p className="error request-controls-error">{requestState.message}</p>
        ) : null}
      </section>
    );
  }

  // TV branch. Seasons are picked explicitly rather than defaulting to the
  // whole show, so the submit button stays disabled until at least one box is
  // ticked. Both branches share the same error line at the bottom.
  return (
    <section className="request-controls" aria-label="Request TV seasons">
      {partialAvailabilityContext}
      {detail.seasons.length === 0 ? (
        <p className="muted">No seasons available to request.</p>
      ) : done ? (
        <p className="request-controls-status">
          {requestState.kind === "already" ? "Already requested" : "Requested"}
        </p>
      ) : (
        <>
          <fieldset className="request-season-pick" disabled={submitting}>
            <legend>Select seasons to request</legend>
            <ul className="request-season-check-list">
              {detail.seasons.map((season) => (
                <li key={season.seasonNumber}>
                  <label className="request-season-check">
                    <input
                      type="checkbox"
                      checked={selectedSeasons.includes(season.seasonNumber)}
                      onChange={() => toggleSeason(season.seasonNumber)}
                    />
                    <span>
                      {season.name}
                      <span className="muted">
                        {" "}
                        ({season.episodeCount} ep
                        {season.episodeCount === 1 ? "" : "s"})
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          {qualityProfilePicker}
          <button
            type="button"
            className="btn"
            disabled={submitting || selectedSeasons.length === 0}
            onClick={() => void submit(selectedSeasons)}
          >
            {submitting ? "Requesting…" : "Request selected seasons"}
          </button>
        </>
      )}
      {requestState.kind === "error" ? (
        <p className="error request-controls-error">{requestState.message}</p>
      ) : null}
    </section>
  );
}
