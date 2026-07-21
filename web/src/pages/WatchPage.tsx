import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  fetchEpisodeWatch,
  fetchMovieWatch,
  fetchNextEpisode,
  type NextEpisode,
  type WatchDescriptor,
  type WatchTuning,
} from "../api/watch";
import {
  PlayerControls,
  type QualityId,
  type StreamSettings,
} from "../components/PlayerControls";

const AUTO_PLAY_STORAGE_KEY = "tyflix.autoPlay";

type LoadStatus = "loading" | "ready" | "error";

type PendingResume = {
  position: number;
  wasPlaying: boolean;
};

function readStoredAutoPlay(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_PLAY_STORAGE_KEY);
    if (raw === null) {
      return true;
    }
    return raw === "true";
  } catch {
    return true;
  }
}

function writeStoredAutoPlay(value: boolean): void {
  try {
    localStorage.setItem(AUTO_PLAY_STORAGE_KEY, String(value));
  } catch {
    // private mode / quota — preference stays in-memory only
  }
}

function parseTmdbId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function tuningForQuality(quality: QualityId): WatchTuning {
  switch (quality) {
    case "original":
      return {};
    case "1080p":
      return { maxVideoBitrate: 12000, videoResolution: "1920x1080" };
    case "720p":
      return { maxVideoBitrate: 4000, videoResolution: "1280x720" };
    case "480p":
      return { maxVideoBitrate: 1500, videoResolution: "854x480" };
  }
}

function buildWatchTuning(settings: StreamSettings): WatchTuning | undefined {
  const tuning: WatchTuning = {
    ...tuningForQuality(settings.quality),
    ...(settings.audioStreamId
      ? { audioStreamID: settings.audioStreamId }
      : {}),
  };
  return Object.keys(tuning).length > 0 ? tuning : undefined;
}

export function WatchPage() {
  const navigate = useNavigate();
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
  const [autoPlay, setAutoPlay] = useState(readStoredAutoPlay);
  const [nextEpisode, setNextEpisode] = useState<NextEpisode | null>(null);
  const autoPlayRef = useRef(autoPlay);
  const nextEpisodeRef = useRef(nextEpisode);
  autoPlayRef.current = autoPlay;
  nextEpisodeRef.current = nextEpisode;

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

  // Prefetch the next episode so auto-advance can navigate without waiting.
  // Soft-fail: a null/failed result just disables advance for this episode.
  useEffect(() => {
    if (!isEpisode || ratingKey === null) {
      setNextEpisode(null);
      return;
    }

    let cancelled = false;
    setNextEpisode(null);
    void fetchNextEpisode(ratingKey).then((next) => {
      if (!cancelled) {
        setNextEpisode(next);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isEpisode, ratingKey]);

  // Auto-advance on ended. Refs keep the listener current without rebinding
  // on every autoPlay / nextEpisode change.
  useEffect(() => {
    if (descriptor === null) {
      return;
    }
    const video = videoRef.current;
    if (video === null) {
      return;
    }

    const onEnded = () => {
      if (!autoPlayRef.current) {
        return;
      }
      const next = nextEpisodeRef.current;
      if (next === null) {
        return;
      }
      navigate(`/watch/episode/${next.ratingKey}`);
    };

    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("ended", onEnded);
    };
  }, [descriptor, navigate]);

  // Wire up playback once a descriptor is ready. Tries the local connection
  // first and falls back to the remote one on a fatal hls.js error.
  // Quality/audio switches update descriptor in place (status stays "ready") so
  // the <video> stays mounted; pendingResumeRef carries position across rebuilds.
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

    // Fast-fail only the LOCAL master-manifest probe (~3s, no retries) so an
    // unreachable LAN plex.direct falls over to remote quickly. Fragment and
    // media-playlist timeouts stay at hls.js defaults — cold Plex transcodes
    // can take several seconds even on a reachable local link. Remote (and
    // primary-when-local-is-null) keeps patient default timeouts.
    const attach = (source: string, fastFail: boolean) => {
      hls = new Hls({
        enableWorker: false,
        ...(fastFail
          ? {
              manifestLoadPolicy: {
                default: {
                  maxTimeToFirstByteMs: 3000,
                  maxLoadTimeMs: 3000,
                  timeoutRetry: {
                    maxNumRetry: 0,
                    retryDelayMs: 0,
                    maxRetryDelayMs: 0,
                  },
                  errorRetry: {
                    maxNumRetry: 0,
                    retryDelayMs: 0,
                    maxRetryDelayMs: 0,
                  },
                },
              },
            }
          : {}),
      });
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
          attach(remoteUrl, false);
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

    attach(primaryUrl, primaryUrl === localUrl);

    return () => {
      hls?.destroy();
      hls = null;
    };
  }, [descriptor]);

  const onAutoPlayChange = (value: boolean) => {
    setAutoPlay(value);
    writeStoredAutoPlay(value);
  };

  const onStreamSettingsChange = async (
    settings: StreamSettings,
  ): Promise<void> => {
    const video = videoRef.current;
    if (video === null) {
      // No-op for the player; reject so the settings highlights stay put.
      throw new Error("Player not ready");
    }

    pendingResumeRef.current = {
      position: video.currentTime,
      wasPlaying: !video.paused,
    };

    const tuning = buildWatchTuning(settings);
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
        err instanceof Error ? err.message : "Failed to switch stream settings",
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
          audioTracks={descriptor.streams.audio}
          onStreamSettingsChange={onStreamSettingsChange}
          autoPlay={isEpisode ? autoPlay : undefined}
          onAutoPlayChange={isEpisode ? onAutoPlayChange : undefined}
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
