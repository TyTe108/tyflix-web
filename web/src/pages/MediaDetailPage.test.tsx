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
import {
  fetchCredits,
  fetchMovie,
  fetchRecommendations,
  fetchTv,
  type MovieDetail,
  type TvDetail,
} from "../api/discover";
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

function pageMain() {
  return screen.getByRole("main");
}

describe("MediaDetailPage hero", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(fetchCredits).mockResolvedValue({ cast: [], crew: [] });
    vi.mocked(fetchRecommendations).mockResolvedValue([]);
  });

  // Guards the frame: the hero class is only there once the title has loaded.
  it("uses page-hero when ready, and the plain full page while loading", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    vi.mocked(fetchTv).mockReturnValue(new Promise<TvDetail>(() => {}));

    const pending = renderDetail();
    expect(pageMain().className).toBe("page page-full");
    expect(screen.getByRole("link", { name: "Back" })).toBeTruthy();
    expect(document.querySelector(".media-hero")).toBeNull();

    pending.unmount();
    vi.mocked(fetchTv).mockResolvedValue(tvDetail);
    renderDetail();
    expect(await screen.findByRole("heading", { name: /Breaking Bad/ })).toBeTruthy();
    expect(pageMain().className).toBe("page page-full page-hero");
  });

  // Guards Back on a direct load: one link home, inside the hero, and no header row.
  it("puts a single home link inside the hero on a direct load", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    vi.mocked(fetchTv).mockResolvedValue(tvDetail);
    renderDetail();

    expect(await screen.findByRole("heading", { name: /Breaking Bad/ })).toBeTruthy();
    const hero = document.querySelector(".media-hero");
    expect(hero).toBeTruthy();
    const back = screen.getByRole("link", { name: "Back" });
    expect(back.getAttribute("href")).toBe("/");
    expect(hero!.contains(back)).toBe(true);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(document.querySelector("header.row")).toBeNull();
  });

  // Guards Back after in-app navigation: one button, inside the hero, and no header row.
  it("puts a single Back button inside the hero after in-app navigation", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    vi.mocked(fetchTv).mockResolvedValue(tvDetail);
    render(
      <MemoryRouter initialEntries={["/library", "/media/tv/1396"]} initialIndex={1}>
        <AuthProvider>
          <Routes>
            <Route path="/media/:type/:id" element={<MediaDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: /Breaking Bad/ })).toBeTruthy();
    const hero = document.querySelector(".media-hero");
    expect(hero).toBeTruthy();
    const back = screen.getByRole("button", { name: "Back" });
    expect(hero!.contains(back)).toBe(true);
    expect(screen.queryByRole("link", { name: "Back" })).toBeNull();
    expect(document.querySelector("header.row")).toBeNull();
  });

  // Guards the image chain's first choice: the backdrop is the hero image.
  it("uses the backdrop as the hero image when both urls are set", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    vi.mocked(fetchMovie).mockResolvedValue({
      ...movieDetail,
      backdropUrl: "https://image.tmdb.org/t/p/w1280/br-bg.jpg",
      posterUrl: "https://image.tmdb.org/t/p/w500/br.jpg",
    });
    render(
      <MemoryRouter initialEntries={["/media/movie/550"]}>
        <AuthProvider>
          <Routes>
            <Route path="/media/:type/:id" element={<MediaDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: /Fight Club/ })).toBeTruthy();
    expect(document.querySelector(".media-hero img")?.getAttribute("src")).toBe(
      "https://image.tmdb.org/t/p/w1280/br-bg.jpg",
    );
  });

  // Guards the image chain's second choice: the poster when there is no backdrop.
  it("uses the poster as the hero image when only posterUrl is set", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    vi.mocked(fetchMovie).mockResolvedValue({
      ...movieDetail,
      backdropUrl: null,
      posterUrl: "https://image.tmdb.org/t/p/w500/br.jpg",
    });
    render(
      <MemoryRouter initialEntries={["/media/movie/550"]}>
        <AuthProvider>
          <Routes>
            <Route path="/media/:type/:id" element={<MediaDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: /Fight Club/ })).toBeTruthy();
    expect(document.querySelector(".media-hero img")?.getAttribute("src")).toBe(
      "https://image.tmdb.org/t/p/w500/br.jpg",
    );
  });

  // Guards the image chain's last choice: no image and no placeholder text.
  it("renders the hero art with no image when both urls are missing", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    vi.mocked(fetchMovie).mockResolvedValue({
      ...movieDetail,
      backdropUrl: null,
      posterUrl: null,
    });
    render(
      <MemoryRouter initialEntries={["/media/movie/550"]}>
        <AuthProvider>
          <Routes>
            <Route path="/media/:type/:id" element={<MediaDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: /Fight Club/ })).toBeTruthy();
    const hero = document.querySelector(".media-hero");
    expect(hero).toBeTruthy();
    expect(hero!.querySelector("img")).toBeNull();
    expect(hero!.textContent).not.toContain("No image");
  });

  // Guards the hero's reading order for a movie that can be played.
  it("lays the movie title block out in the hero, with Play named Play", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    vi.mocked(fetchCredits).mockResolvedValue({
      cast: [],
      crew: [
        {
          id: 7,
          name: "Ada Quinn",
          job: "Director",
          profileUrl: null,
        },
      ],
    });
    vi.mocked(fetchMovie).mockResolvedValue({
      ...movieDetail,
      title: "Bright River",
      overview: "A long story.",
      genres: ["Drama", "Thriller"],
      runtime: 45,
      collection: { id: 9, name: "River Set" },
      mediaStatus: "available",
    });
    render(
      <MemoryRouter initialEntries={["/media/movie/550"]}>
        <AuthProvider>
          <Routes>
            <Route path="/media/:type/:id" element={<MediaDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    const info = (await screen.findByRole("heading", { name: /Bright River/ }))
      .closest(".media-hero-info") as HTMLElement;
    expect(info).toBeTruthy();
    const tag = info.querySelector(".media-detail-tag-row")!;
    const title = within(info).getByRole("heading", { level: 1 });
    const collection = within(info).getByRole("link", { name: "Part of the River Set" });
    const genres = within(info).getByText("Drama · Thriller");
    const runtime = within(info).getByText("45m");
    const actions = info.querySelector(".media-hero-actions")!;
    const overview = within(info).getByText("A long story.");
    const crew = await within(info).findByText("Directed by Ada Quinn");
    const play = within(actions as HTMLElement).getByRole("link", { name: "Play" });
    const request = actions.querySelector("section.request-controls")!;

    const order = [tag, title, collection, genres, runtime, actions, overview, crew];
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(
        order[i]!.compareDocumentPosition(order[i + 1]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(
      play.compareDocumentPosition(request) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Guards the sections under the hero: Manage, Report, Episodes, Cast, More like this.
  it("places Manage, Report, Episodes, Cast and More like this after the hero", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(true));
    vi.mocked(fetchCredits).mockResolvedValue({
      cast: [
        {
          id: 3,
          name: "Actor One",
          character: "Lead",
          profileUrl: null,
        },
      ],
      crew: [],
    });
    vi.mocked(fetchRecommendations).mockResolvedValue([
      {
        tmdbId: 2,
        mediaType: "tv",
        title: "Other Show",
        year: 2001,
        posterUrl: null,
        overview: "Another.",
        mediaStatus: null,
      },
    ]);
    vi.mocked(fetchTv).mockResolvedValue({
      ...tvDetail,
      title: "North Line",
      mediaStatus: "available",
    });
    renderDetail();

    const hero = (await screen.findByRole("heading", { name: /North Line/ })).closest(
      ".media-hero",
    );
    expect(hero).toBeTruthy();
    const manage = await screen.findByRole("button", { name: "Manage" });
    const report = await screen.findByRole("heading", { name: "Report an issue" });
    const episodes = await screen.findByRole("heading", { name: "Episodes" });
    const cast = await screen.findByRole("heading", { name: "Cast" });
    const more = await screen.findByRole("heading", { name: "More like this" });

    for (const node of [manage, report, episodes, cast, more]) {
      expect(hero!.contains(node)).toBe(false);
      expect(
        hero!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    const below = [manage, report, episodes, cast, more];
    for (let i = 0; i < below.length - 1; i += 1) {
      expect(
        below[i]!.compareDocumentPosition(below[i + 1]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });
});
