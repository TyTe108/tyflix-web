import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchCollection,
  type CollectionDetail,
} from "../api/discover";
import { MediaCard } from "../components/MediaCard";

type LoadStatus = "loading" | "ready" | "error";
type LoadedCollection = CollectionDetail & { requestedId: number };

function parseCollectionId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function CollectionPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = parseCollectionId(rawId);
  const [collection, setCollection] = useState<LoadedCollection | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const currentCollection =
    collection !== null && collection.requestedId === id ? collection : null;

  const retry = useCallback(() => {
    setReloadKey((value) => value + 1);
  }, []);

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

function CollectionContent({
  collection,
}: {
  collection: CollectionDetail;
}) {
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
