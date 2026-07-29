// A TMDB movie collection (the Bond films, the Star Wars saga, that kind of
// thing): hero art, overview, and a poster grid of every part. Rendered at
// /collection/:id by App.tsx, inside ProtectedRoute and AppShell.
//
// One call, GET /api/discover/collection/:id through api/discover.ts. The
// server layers Seerr availability onto each part, so the cards show the same
// green and amber status corners you get on Discover. MediaDetailPage links
// here when a movie belongs to a collection.

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchCollection,
  type CollectionDetail,
} from "../api/discover";
import { MediaCard } from "../components/MediaCard";

// Drives which of the three mutually exclusive body states renders below.
type LoadStatus = "loading" | "ready" | "error";
// Tags the loaded payload with the id it was fetched for. Navigating between
// two collections re-runs the effect but the old data is still in state for a
// frame, and the tag is what lets the render skip it.
type LoadedCollection = CollectionDetail & { requestedId: number };

// Rejects anything that isn't a plain positive integer before it reaches the
// API, so a junk URL segment renders "not found" instead of firing a request.
function parseCollectionId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Detail page for one TMDB collection.
 *
 * An unparseable :id short-circuits to the error state with no network call,
 * and the retry button hides in that case because retrying can't help.
 */
export function CollectionPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = parseCollectionId(rawId);
  const [collection, setCollection] = useState<LoadedCollection | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Only show state that belongs to the id currently in the URL. Without this
  // the previous collection flashes on screen while the new one loads.
  const currentCollection =
    collection !== null && collection.requestedId === id ? collection : null;

  const retry = useCallback(() => {
    setReloadKey((value) => value + 1);
  }, []);

  // Owns the collection load. Re-runs when the route id changes or on retry.
  useEffect(() => {
    if (id === null) {
      setCollection(null);
      setStatus("error");
      setError("Collection not found");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);

    void fetchCollection(id)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setCollection({ ...result, requestedId: id });
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setCollection(null);
        setStatus("error");
        // getJson stringifies the status into the message, so a TMDB miss
        // arrives as "Request failed (404)". Turn that one case into something
        // a user can read and pass everything else through untouched.
        const message =
          err instanceof Error ? err.message : "Failed to load collection";
        setError(message.includes("(404)") ? "Collection not found" : message);
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
        <p className="muted collection-loading">Loading collection…</p>
      ) : null}

      {/* Retry only makes sense when there was a real request to retry. A bad
          :id in the URL gets a way out instead. */}
      {status === "error" ? (
        <div className="stats-error collection-error">
          <p className="error">{error ?? "Failed to load collection"}</p>
          {id !== null ? (
            <button type="button" className="btn secondary" onClick={retry}>
              Retry
            </button>
          ) : (
            <Link to="/discover">Back to Discover</Link>
          )}
        </div>
      ) : null}

      {status === "ready" && currentCollection !== null ? (
        <CollectionContent collection={currentCollection} />
      ) : null}
    </main>
  );
}

// The loaded state: hero image, name, overview, then the parts grid. Split out
// so the parent stays a straight status switch.
function CollectionContent({
  collection,
}: {
  collection: CollectionDetail;
}) {
  // Prefer the wide backdrop for the hero, fall back to the poster, and if
  // TMDB has neither the placeholder holds the space.
  const imageUrl = collection.backdropUrl ?? collection.posterUrl;

  return (
    <article className="collection-detail">
      <header>
        <div className="collection-hero">
          {imageUrl !== null ? (
            <img className="collection-hero-img" src={imageUrl} alt="" />
          ) : (
            <div className="collection-hero-placeholder" aria-hidden="true">
              No image
            </div>
          )}
        </div>
        <h1>{collection.name}</h1>
        {collection.overview ? (
          <p className="collection-overview">{collection.overview}</p>
        ) : (
          <p className="muted">No overview available.</p>
        )}
      </header>

      <section className="collection-parts" aria-labelledby="parts-heading">
        <h2 id="parts-heading">Movies</h2>
        {collection.parts.length > 0 ? (
          <ul className="media-grid">
            {collection.parts.map((item) => (
              <li key={`${item.mediaType}:${item.tmdbId}`}>
                <MediaCard item={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No movies listed.</p>
        )}
      </section>
    </article>
  );
}
