import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchEpisodeWatch,
  fetchMovieWatch,
  type WatchDescriptor,
  type WatchTuning,
} from "../api/watch";
import {
  PlayerControls,
  type QualityId,
} from "../components/PlayerControls";

type LoadStatus = "loading" | "ready" | "error";

type PendingResume = {
  position: number;
  wasPlaying: boolean;
};

function parseTmdbId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function tuningForQuality(quality: QualityId): WatchTuning | undefined {
  switch (quality) {
    case "original":
      return undefined;
    case "1080p":
      return { maxVideoBitrate: 12000, videoResolution: "1920x1080" };
    case "720p":
      return { maxVideoBitrate: 4000, videoResolution: "1280x720" };
    case "480p":
      return { maxVideoBitrate: 1500, videoResolution: "854x480" };
  }
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
  const pendingResumeRef = useRef<PendingResume | null>(null);
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
    pendingResumeRef.current = null;

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
  // Quality switches update descriptor in place (status stays "ready") so the
  // <video> stays mounted; pendingResumeRef carries position across rebuilds.
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

    const applyPendingResume = () => {
      const pending = pendingResumeRef.current;
      if (pending === null) {
        return;
      }
      pendingResumeRef.current = null;
      video.currentTime = pending.position;
      if (pending.wasPlaying) {
        void video.play().catch((err: unknown) => {
          console.error("Resume play failed", err);
        });
      } else {
        video.pause();
      }
    };

    // Safari (and other native HLS players) can play the manifest directly.
    if (!Hls.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl") !== "") {
        if (pendingResumeRef.current !== null) {
          video.pause();
        }
        const onLoadedMetadata = () => {
          video.removeEventListener("loadedmetadata", onLoadedMetadata);
          applyPendingResume();
        };
        video.addEventListener("loadedmetadata", onLoadedMetadata);
        video.src = primaryUrl;
        return () => {
          video.removeEventListener("loadedmetadata", onLoadedMetadata);
        };
      }
      setStatus("error");
      setError("Your browser can't play this stream");
      return;
    }

    let hls: Hls | null = null;
    let usedRemote = primaryUrl === remoteUrl;

    if (pendingResumeRef.current !== null) {
      // Avoid briefly playing from 0:00 while the new quality manifest loads.
      video.pause();
    }

    const attach = (source: string) => {
      hls = new Hls({ enableWorker: false });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        applyPendingResume();
      });
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
        pendingResumeRef.current = null;
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

  const onSelectQuality = async (quality: QualityId): Promise<void> => {
    const video = videoRef.current;
    if (video === null) {
      // No-op for the player; reject so the settings highlight stays put.
      throw new Error("Player not ready");
    }

    pendingResumeRef.current = {
      position: video.currentTime,
      wasPlaying: !video.paused,
    };

    const tuning = tuningForQuality(quality);
    try {
      let result: WatchDescriptor;
      if (isEpisode) {
        if (ratingKey === null) {
          throw new Error("Invalid episode");
        }
        result = await fetchEpisodeWatch(ratingKey, tuning);
      } else {
        if (tmdbId === null) {
          throw new Error("Invalid title");
        }
        result = await fetchMovieWatch(tmdbId, tuning);
      }
      // Keep status "ready" and the existing descriptor until the new one
      // arrives so the <video> (and PlayerControls listeners) stay mounted.
      setDescriptor(result);
    } catch (err: unknown) {
      pendingResumeRef.current = null;
      setStatus("error");
      setError(
        err instanceof Error ? err.message : "Failed to switch quality",
      );
      throw err;
    }
  };

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
        <PlayerControls
          videoRef={videoRef}
          durationMs={descriptor.durationMs}
          onSelectQuality={onSelectQuality}
        >
          <video
            ref={videoRef}
            className="watch-player"
            autoPlay
            playsInline
          />
        </PlayerControls>
      ) : null}
    </main>
  );
}
