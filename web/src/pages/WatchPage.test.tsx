// Redaction for Phase 37.0 HLS playback diagnostics. Stream URLs carry
// X-Plex-Token; the on-screen error and console.error payload must never leak
// it. Wording of the diagnostic message is deliberately not asserted — only
// that the secret is absent and the hostname remains.
//
// Also covers wantsFullscreenFromNavState: the Play gesture latch that
// WatchPage reads from location.state before mounting PlayerControls.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMe } from "../api/auth";
import { fetchMovie, type MovieDetail } from "../api/discover";
import { AuthProvider } from "../auth/AuthContext";
import { MediaDetailPage } from "./MediaDetailPage";
import {
  buildHlsPlaybackFailureReport,
  wantsFullscreenFromNavState,
} from "./WatchPage";

vi.mock("../api/auth", () => ({
  fetchMe: vi.fn(),
  logoutRequest: vi.fn(),
}));

vi.mock("../api/discover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/discover")>();
  return {
    ...actual,
    fetchTv: vi.fn(),
    fetchMovie: vi.fn(),
    fetchCredits: vi.fn().mockResolvedValue({ cast: [], crew: [] }),
    fetchRecommendations: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../api/requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/requests")>();
  return {
    ...actual,
    createRequest: vi.fn(),
    fetchRequestProfiles: vi.fn().mockResolvedValue({
      serverId: 1,
      defaultProfileId: 1,
      profiles: [{ id: 1, name: "Any" }],
    }),
    fetchAllRequests: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../api/admin", () => ({
  removeMedia: vi.fn(),
  fetchSeasonTree: vi.fn().mockResolvedValue({
    tmdbId: 550,
    sonarrSeriesId: null,
    seasons: [],
  }),
  removeSeason: vi.fn(),
  removeEpisode: vi.fn(),
}));

vi.mock("../api/watch", () => ({
  fetchEpisodes: vi.fn().mockResolvedValue({ episodes: [] }),
}));

vi.mock("../api/issues", () => ({
  createIssue: vi.fn(),
}));

const HOST = "1-2-3.12345.plex.direct";
const SECRET = "SECRETVALUE";
const STREAM_URL =
  `https://${HOST}:32400/video/:/transcode/universal/start.m3u8` +
  `?X-Plex-Token=${SECRET}&session=abc123`;

describe("HLS playback failure diagnostics", () => {
  it("redacts X-Plex-Token from the on-screen message and console.error payload", () => {
    const report = buildHlsPlaybackFailureReport({
      hadLocalUrl: true,
      attempts: [
        {
          connection: "local",
          sourceUrl: STREAM_URL,
          data: {
            type: "networkError",
            details: "manifestLoadError",
            fatal: true,
            url: STREAM_URL,
            response: {
              url: STREAM_URL,
              code: 403,
              text: "Forbidden",
            },
          },
        },
        {
          connection: "remote",
          sourceUrl: STREAM_URL,
          data: {
            type: "networkError",
            details: "manifestLoadError",
            fatal: true,
            url: STREAM_URL,
            response: {
              code: 0,
              text: "",
            },
          },
        },
      ],
    });

    expect(report.message).not.toContain(SECRET);
    expect(JSON.stringify(report.logPayload)).not.toContain(SECRET);
    expect(report.message).toContain(HOST);
    expect(JSON.stringify(report.logPayload)).toContain(HOST);
  });
});

describe("wantsFullscreenFromNavState", () => {
  it("is true only for { enterFullscreen: true }", () => {
    expect(wantsFullscreenFromNavState({ enterFullscreen: true })).toBe(true);
  });

  it("is false for null, undefined, primitives, and a non-boolean enterFullscreen", () => {
    expect(wantsFullscreenFromNavState(null)).toBe(false);
    expect(wantsFullscreenFromNavState(undefined)).toBe(false);
    expect(wantsFullscreenFromNavState("yes")).toBe(false);
    expect(wantsFullscreenFromNavState(1)).toBe(false);
    expect(wantsFullscreenFromNavState({ enterFullscreen: "yes" })).toBe(
      false,
    );
  });
});

const movieDetail: MovieDetail = {
  tmdbId: 550,
  mediaType: "movie",
  title: "Fight Club",
  year: 1999,
  overview: "A movie.",
  posterUrl: null,
  backdropUrl: null,
  runtime: 139,
  genres: [],
  status: "Released",
  collection: null,
  mediaStatus: "available",
};

function LocationStateProbe() {
  const location = useLocation();
  return <pre data-testid="location-state">{JSON.stringify(location.state)}</pre>;
}

describe("Play navigation enterFullscreen state", () => {
  afterEach(() => {
    cleanup();
  });

  it("MediaDetailPage ▶ Play navigates with { enterFullscreen: true }", async () => {
    vi.mocked(fetchMe).mockResolvedValue({
      isAdmin: false,
      user: {
        seerrUserId: 1,
        plexId: 1,
        plexUsername: "testuser",
        displayName: "Test User",
        avatar: null,
        permissions: 0,
      },
    });
    vi.mocked(fetchMovie).mockResolvedValue(movieDetail);

    render(
      <MemoryRouter initialEntries={["/media/movie/550"]}>
        <AuthProvider>
          <Routes>
            <Route path="/media/:type/:id" element={<MediaDetailPage />} />
            <Route path="/watch/movie/:tmdbId" element={<LocationStateProbe />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    const play = await screen.findByRole("link", { name: /Play/ });
    fireEvent.click(play);

    expect(screen.getByTestId("location-state").textContent).toBe(
      JSON.stringify({ enterFullscreen: true }),
    );
  });
});
