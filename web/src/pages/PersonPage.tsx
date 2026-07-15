import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchPerson,
  type MediaSummary,
  type PersonDetail,
} from "../api/discover";
import { MediaCard } from "../components/MediaCard";

type LoadStatus = "loading" | "ready" | "error";
type LoadedPerson = {
  requestedId: number;
  person: PersonDetail;
  credits: MediaSummary[];
};

function parsePersonId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

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

export function PersonPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = parsePersonId(rawId);
  const [result, setResult] = useState<LoadedPerson | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [biographyExpanded, setBiographyExpanded] = useState(false);
  const currentResult =
    result !== null && result.requestedId === id ? result : null;

  const retry = useCallback(() => {
    setReloadKey((value) => value + 1);
  }, []);

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
  const biographyIsLong = person.biography.length > 400;
  const details = [
    person.birthday !== null
      ? `Born ${formatBirthday(person.birthday)}`
      : null,
    person.placeOfBirth,
  ].filter((value): value is string => value !== null && value !== "");

  return (
    <article className="person-detail">
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
