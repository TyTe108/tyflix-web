// Season checklist behavior on MediaDetail: tapping a season's label toggles
// its checkbox (the thumb-usable label pattern for 36.4). Also covers the
// admin-only Manage entry point on the title page, that ▶ Play latches
// { enterFullscreen: true } onto the watch-route navigation state, and which
// Back control renders: a link home on a direct load or a landing entry, and
// a button after in-app navigation.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMe } from "../api/auth";
import { fetchMovie, fetchTv, type MovieDetail, type TvDetail } from "../api/discover";
import { AuthProvider } from "../auth/AuthContext";
import { MediaDetailPage } from "./MediaDetailPage";

vi.mock("../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/auth")>();
  return {
    ...actual,
    fetchMe: vi.fn(),
    logoutRequest: vi.fn(),
  };
});

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
    tmdbId: 1396,
    sonarrSeriesId: 97,
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

const tvDetail: TvDetail = {
  tmdbId: 1396,
  mediaType: "tv",
  title: "Breaking Bad",
  overview: "A show.",
  posterUrl: null,
  backdropUrl: null,
  year: 2008,
  genres: [],
  status: "Ended",
  mediaStatus: "unknown",
  seasons: [
    { seasonNumber: 1, name: "Season 1", episodeCount: 7 },
    { seasonNumber: 2, name: "Season 2", episodeCount: 13 },
  ],
  tvdbId: 1,
};

function meUser(isAdmin: boolean) {
  return {
    isAdmin,
    user: {
      seerrUserId: 1,
      plexId: 1,
      plexUsername: "testuser",
      displayName: "Test User",
      avatar: null,
      permissions: isAdmin ? 2 : 0,
    },
    preferences: { fullscreenOnPlay: true },
  };
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/media/tv/1396"]}>
      <AuthProvider>
        <Routes>
          <Route path="/media/:type/:id" element={<MediaDetailPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("MediaDetailPage season labels", () => {
  afterEach(() => {
    cleanup();
  });

  it("toggles a season checkbox when its label is clicked", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    vi.mocked(fetchTv).mockResolvedValue(tvDetail);

    renderDetail();

    const checklist = await screen.findByRole("group", {
      name: "Select seasons to request",
    });
    const season1 = within(checklist).getByLabelText(/Season 1/) as HTMLInputElement;
    expect(season1.checked).toBe(false);

    fireEvent.click(season1.closest("label")!);
    expect(season1.checked).toBe(true);

    fireEvent.click(season1.closest("label")!);
    expect(season1.checked).toBe(false);
  });
});

describe("MediaDetailPage Manage entry", () => {
  afterEach(() => {
    cleanup();
  });

  it("hides the Manage button for a non-admin", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    vi.mocked(fetchTv).mockResolvedValue(tvDetail);

    renderDetail();
    expect(await screen.findByRole("heading", { name: /Breaking Bad/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
  });

  it("shows the Manage button for an admin and opens the modal", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(true));
    vi.mocked(fetchTv).mockResolvedValue(tvDetail);

    renderDetail();
    const manage = await screen.findByRole("button", { name: "Manage" });
    fireEvent.click(manage);
    expect(await screen.findByRole("dialog")).toBeTruthy();
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
      preferences: { fullscreenOnPlay: true },
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

describe("MediaDetailPage Back control", () => {
  afterEach(() => {
    cleanup();
  });

  async function renderBack(
    initialEntries: Array<string | { pathname: string; state?: unknown }>,
    initialIndex?: number,
  ) {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    vi.mocked(fetchTv).mockResolvedValue(tvDetail);
    render(
      <MemoryRouter
        initialEntries={initialEntries}
        initialIndex={initialIndex}
      >
        <AuthProvider>
          <Routes>
            <Route path="/media/:type/:id" element={<MediaDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: /Breaking Bad/ }),
    ).toBeTruthy();
  }

  it("links home on a direct load", async () => {
    await renderBack(["/media/tv/1396"]);
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe(
      "/",
    );
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  // Two entries, and the title is the current one, so location.key is not
  // "default". The landing marker is what still asks for the link home.
  it("links home when the entry carries a landing state", async () => {
    await renderBack(
      ["/library", { pathname: "/media/tv/1396", state: { landing: true } }],
      1,
    );
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe(
      "/",
    );
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("renders a button after in-app navigation", async () => {
    await renderBack(["/library", "/media/tv/1396"], 1);
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Back" })).toBeNull();
  });

  // What /tv/abc becomes after the redirect: an invalid id on a landing
  // entry. The error state draws a second Back, so both have to be links.
  it("links home for an invalid id carrying a landing state", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    render(
      <MemoryRouter
        initialEntries={[
          "/library",
          { pathname: "/media/tv/abc", state: { landing: true } },
        ]}
        initialIndex={1}
      >
        <AuthProvider>
          <Routes>
            <Route path="/media/:type/:id" element={<MediaDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Invalid media link.")).toBeTruthy();
    const backs = screen.getAllByRole("link", { name: "Back" });
    expect(backs).toHaveLength(2);
    for (const back of backs) {
      expect(back.getAttribute("href")).toBe("/");
    }
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});
