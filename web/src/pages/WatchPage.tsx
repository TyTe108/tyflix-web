import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchEpisodeWatch,
  fetchMovieWatch,
  type WatchDescriptor,
} from "../api/watch";

type LoadStatus = "loading" | "ready" | "error";

function parseTmdbId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function WatchPage() {
  const { tmdbId: rawTmdbId, ratingKey: rawRatingKey } = useParams<{
    tmdbId: string;
    ratingKey: string;
  }>();
  // The /watch/episode/:ratingKey route always supplies ratingKey; the
  // /watch/movie/:tmdbId route supplies tmdbId. Pick the source accordingly.
  const isEpisode = rawRatingKey !== undefined;
  const ratingKey =
    isEpisode && /^\d+$/.test(rawRatingKey) ? rawRatingKey : null;
  const tmdbId = parseTmdbId(rawTmdbId);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [descriptor, setDescriptor] = useState<WatchDescriptor | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let load: (() => Promise<WatchDescriptor>) | null = null;
    if (isEpisode) {
      if (ratingKey !== null) {
        load = () => fetchEpisodeWatch(ratingKey);
      }
    } else if (tmdbId !== null) {
      load = () => fetchMovieWatch(tmdbId);
    }

    if (load === null) {
      setDescriptor(null);
      setStatus("error");
      setError(isEpisode ? "Invalid episode" : "Invalid title");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);
    setDescriptor(null);

    void load()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setDescriptor(result);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setDescriptor(null);
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to load stream");
      });

    return () => {
      cancelled = true;
    };
  }, [isEpisode, ratingKey, tmdbId]);

  // Wire up playback once a descriptor is ready. Tries the local connection
  // first and falls back to the remote one on a fatal hls.js error.
  useEffect(() => {
    if (descriptor === null) {
      return;
    }
    const video = videoRef.current;
    if (video === null) {
      return;
    }

    const localUrl = descriptor.hls.local;
    const remoteUrl = descriptor.hls.remote;
    const primaryUrl = localUrl ?? remoteUrl;

    // Safari (and other native HLS players) can play the manifest directly.
    if (!Hls.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl") !== "") {
        video.src = primaryUrl;
        return;
      }
      setStatus("error");
      setError("Your browser can't play this stream");
      return;
    }

    let hls: Hls | null = null;
    let usedRemote = primaryUrl === remoteUrl;

    const attach = (source: string) => {
      hls = new Hls({ enableWorker: false });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) {
          return;
        }
        // On a fatal error, fall back local → remote once; if remote also
        // fails, surface a visible error rather than a silent dead player.
        if (!usedRemote && remoteUrl !== source) {
          usedRemote = true;
          hls?.destroy();
          attach(remoteUrl);
          return;
        }
        hls?.destroy();
        hls = null;
        setStatus("error");
        setError("Playback failed on all connections");
      });
      hls.loadSource(source);
      hls.attachMedia(video);
    };

    attach(primaryUrl);

    return () => {
      hls?.destroy();
      hls = null;
    };
  }, [descriptor]);

  return (
    <main className="page page-wide">
      <header className="row">
        <Link to="/">← Back</Link>
      </header>

      {status === "loading" ? (
        <p className="muted">Loading stream…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load stream"}</p>
          <Link to="/" className="btn secondary">
            Back
          </Link>
        </div>
      ) : null}

      {status === "ready" && descriptor !== null ? (
        <video
          ref={videoRef}
          className="watch-player"
          controls
          autoPlay
          playsInline
        />
      ) : null}
    </main>
  );
}
