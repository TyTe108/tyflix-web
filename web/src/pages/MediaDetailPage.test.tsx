// Season checklist behavior on MediaDetail: tapping a season's label toggles
// its checkbox (the thumb-usable label pattern for 36.4). Also covers the
// admin-only Manage entry point on the title page.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMe } from "../api/auth";
import { fetchTv, type TvDetail } from "../api/discover";
import { AuthProvider } from "../auth/AuthContext";
import { MediaDetailPage } from "./MediaDetailPage";

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
