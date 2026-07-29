// An actor's or director's page: headshot, biography, and a poster grid of
// their credits. Rendered at /person/:id by App.tsx, inside ProtectedRoute and
// AppShell.
//
// One call, GET /api/discover/person/:id through api/discover.ts, which
// returns the person and their credits together. The credits come back with
// Seerr availability already stamped on, so the cards here carry the same
// status corners as Discover. MediaDetailPage's cast and crew rows link in.

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchPerson,
  type MediaSummary,
  type PersonDetail,
} from "../api/discover";
import { MediaCard } from "../components/MediaCard";

// Drives which of the three mutually exclusive body states renders below.
type LoadStatus = "loading" | "ready" | "error";
// Tags the payload with the id it was fetched for. Clicking from one actor to
// another re-runs the effect while the old person is still in state, and the
// tag is what keeps that stale data off screen.
type LoadedPerson = {
  requestedId: number;
  person: PersonDetail;
  credits: MediaSummary[];
};

// Rejects anything that isn't a plain positive integer, so a junk URL segment
// renders "not found" without firing a request.
function parsePersonId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// TMDB gives birthdays as a bare YYYY-MM-DD with no timezone. Parsing that
// with the local Date constructor shifts the day backwards west of UTC, so
// build it in UTC and format in UTC. Anything not matching the shape is passed
// through as-is rather than guessed at.
function formatBirthday(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return value;
  }
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Detail page for one TMDB person.
 *
 * An unparseable :id short-circuits to the error state with no network call,
 * and the retry button hides in that case because retrying can't help.
 */
export function PersonPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = parsePersonId(rawId);
  const [result, setResult] = useState<LoadedPerson | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [biographyExpanded, setBiographyExpanded] = useState(false);
  // Only render state belonging to the id currently in the URL, otherwise the
  // previous person flashes on screen while the new one loads.
  const currentResult =
    result !== null && result.requestedId === id ? result : null;

  const retry = useCallback(() => {
    setReloadKey((value) => value + 1);
  }, []);

  // Owns the person load. Re-runs on route id change or retry. It also resets
  // the biography expander first, since a bio left open on the last person
  // shouldn't carry over to the next one.
  useEffect(() => {
    setBiographyExpanded(false);
    if (id === null) {
      setResult(null);
      setStatus("error");
      setError("Person not found");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);

    void fetchPerson(id)
      .then(({ person, credits }) => {
        if (cancelled) {
          return;
        }
        setResult({ requestedId: id, person, credits });
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setResult(null);
        setStatus("error");
        // getJson stringifies the status into the message, so a TMDB miss
        // arrives as "Request failed (404)". Rewrite that one case for humans
        // and pass everything else through untouched.
        const message =
          err instanceof Error ? err.message : "Failed to load person";
        setError(message.includes("(404)") ? "Person not found" : message);
      });

    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  return (
    <main className="page page-wide">
      <header className="row">
        <Link to="/discover">← Back to Discover</Link>
      </header>

      {status === "loading" ? (
        <p className="muted person-loading">Loading person…</p>
      ) : null}

      {/* Retry only makes sense when there was a real request to retry. A bad
          :id in the URL gets a way out instead. */}
      {status === "error" ? (
        <div className="stats-error person-error">
          <p className="error">{error ?? "Failed to load person"}</p>
          {id !== null ? (
            <button type="button" className="btn secondary" onClick={retry}>
              Retry
            </button>
          ) : (
            <Link to="/discover">Back to Discover</Link>
          )}
        </div>
      ) : null}

      {status === "ready" && currentResult !== null ? (
        <PersonContent
          person={currentResult.person}
          credits={currentResult.credits}
          biographyExpanded={biographyExpanded}
          onToggleBiography={() =>
            setBiographyExpanded((expanded) => !expanded)
          }
        />
      ) : null}
    </main>
  );
}

// The loaded state: header, biography with its expander, then the credits
// grid. Expansion is owned by the parent so the effect can reset it on
// navigation, which is why it arrives as props instead of local state.
function PersonContent({
  person,
  credits,
  biographyExpanded,
  onToggleBiography,
}: {
  person: PersonDetail;
  credits: MediaSummary[];
  biographyExpanded: boolean;
  onToggleBiography: () => void;
}) {
  // 400 characters is the cutoff for clamping the bio and showing Read more.
  // Below that the toggle never renders and the paragraph is always full.
  const biographyIsLong = person.biography.length > 400;
  // Birthday and birthplace get joined with a separator, but either can be
  // missing, and TMDB returns an empty string rather than null for an unknown
  // place of birth. Filter both out before joining or you get a stray dot.
  const details = [
    person.birthday !== null
      ? `Born ${formatBirthday(person.birthday)}`
      : null,
    person.placeOfBirth,
  ].filter((value): value is string => value !== null && value !== "");

  return (
    <article className="person-detail">
      {/* Headshot, name, department, and the born/from line. No TMDB
          headshot means a placeholder holding the person's first initial. */}
      <header className="person-header">
        {person.profileUrl !== null ? (
          <img className="person-profile" src={person.profileUrl} alt="" />
        ) : (
          <div
            className="person-profile person-profile-placeholder"
            aria-hidden="true"
          >
            {person.name.slice(0, 1)}
          </div>
        )}
        <div className="person-heading">
          <h1>{person.name}</h1>
          {person.knownForDepartment ? (
            <p className="person-department muted">
              {person.knownForDepartment}
            </p>
          ) : null}
          {details.length > 0 ? (
            <p className="person-meta muted">{details.join(" · ")}</p>
          ) : null}
        </div>
      </header>

      <section className="person-biography-section" aria-labelledby="bio-heading">
        <h2 id="bio-heading">Biography</h2>
        {person.biography ? (
          <>
            <p
              className={`person-biography${
                biographyIsLong && !biographyExpanded ? " collapsed" : ""
              }`}
            >
              {person.biography}
            </p>
            {biographyIsLong ? (
              <button
                type="button"
                className="person-biography-toggle"
                onClick={onToggleBiography}
              >
                {biographyExpanded ? "Read less" : "Read more"}
              </button>
            ) : null}
          </>
        ) : (
          <p className="muted">No biography.</p>
        )}
      </section>

      {/* Credits grid, movies and shows mixed together. TMDB numbers those in
          separate namespaces, so a movie and a series can share an id and the
          React key has to pair the id with mediaType. */}
      <section className="person-known-for" aria-labelledby="known-for-heading">
        <h2 id="known-for-heading">Known for</h2>
        {credits.length > 0 ? (
          <ul className="media-grid">
            {credits.map((item) => (
              <li key={`${item.mediaType}:${item.tmdbId}`}>
                <MediaCard item={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No filmography available.</p>
        )}
      </section>
    </article>
  );
}
