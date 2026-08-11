// Behavioral tests for LibraryPage mobile chrome (36.3): Filters sheet vs
// inline Sort/Genre/Unwatched, active-filter badge, and sheet dismiss.
//
// Layout (sub-130px chrome, horizontal A-Z, 44px targets, full-width grid) is
// CSS and is not asserted here. MobileNav's suite must keep passing unmodified
// — that is the BottomSheet extraction regression net.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchLibraryItems,
  fetchSectionFirstCharacters,
  fetchSectionGenres,
  fetchSections,
} from "../api/library";
import { setViewport } from "../test/setup";
import { LibraryPage } from "./LibraryPage";

vi.mock("../api/library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/library")>();
  return {
    ...actual,
    fetchSections: vi.fn(),
    fetchLibraryItems: vi.fn(),
    fetchSectionGenres: vi.fn(),
    fetchSectionFirstCharacters: vi.fn(),
  };
});

vi.mock("../components/ContinueWatchingRail", () => ({
  ContinueWatchingRail: () => null,
}));

function mockLibraryApis(options?: {
  genresDelay?: boolean;
  genresReject?: boolean;
}) {
  vi.mocked(fetchSections).mockResolvedValue([
    { key: "1", title: "Movies", type: "movie" },
    { key: "2", title: "TV Shows", type: "show" },
  ]);
  vi.mocked(fetchLibraryItems).mockResolvedValue({
    items: [
      {
        ratingKey: "101",
        type: "movie",
        title: "Test Movie",
        year: 2020,
        thumb: null,
        addedAt: null,
        tmdbId: 1,
        summary: null,
        rating: null,
        contentRating: null,
        runtime: null,
        durationMs: null,
        genres: [],
        viewOffset: null,
        viewCount: null,
        lastViewedAt: null,
      },
    ],
    totalSize: 1,
    start: 0,
    size: 48,
    sort: "title",
    genre: null,
    unwatched: false,
    firstCharacter: null,
    query: null,
  });
  if (options?.genresDelay) {
    vi.mocked(fetchSectionGenres).mockReturnValue(new Promise(() => {}));
  } else if (options?.genresReject) {
    vi.mocked(fetchSectionGenres).mockRejectedValue(new Error("genres failed"));
  } else {
    vi.mocked(fetchSectionGenres).mockResolvedValue([
      { id: "7", title: "Action" },
    ]);
  }
  vi.mocked(fetchSectionFirstCharacters).mockResolvedValue([
    { label: "A", count: 1 },
    { label: "T", count: 1 },
  ]);
}

function renderLibrary() {
  return render(
    <MemoryRouter initialEntries={["/library/movies"]}>
      <Routes>
        <Route path="/library/:mediaType" element={<LibraryPage />} />
        <Route path="/library" element={<LibraryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function waitForLibraryReady() {
  await screen.findByRole("heading", { name: "Library" });
  await screen.findByText("Test Movie");
}

describe("LibraryPage filters chrome", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(fetchSections).mockReset();
    vi.mocked(fetchLibraryItems).mockReset();
    vi.mocked(fetchSectionGenres).mockReset();
    vi.mocked(fetchSectionFirstCharacters).mockReset();
    mockLibraryApis();
  });

  afterEach(() => {
    cleanup();
  });

  it("below 48rem: Sort/Genre/Unwatched are not inline; Filters opens them in a sheet", async () => {
    setViewport("mobile");
    renderLibrary();
    await waitForLibraryReady();

    // Search and section toggle stay visible.
    screen.getByPlaceholderText("Search Movies…");
    screen.getByRole("button", { name: "Movies" });

    expect(screen.queryByRole("button", { name: "Filters" })).not.toBeNull();

    // Inline filter labels live outside the sheet on desktop only.
    const filtersRegion = screen.queryByLabelText("Library filters");
    if (filtersRegion) {
      expect(
        within(filtersRegion).queryByText("Sort", { selector: "span" }),
      ).toBeNull();
      expect(
        within(filtersRegion).queryByText("Genre", { selector: "span" }),
      ).toBeNull();
      expect(
        within(filtersRegion).queryByText("Unwatched only"),
      ).toBeNull();
    }

    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    within(sheet).getByText("Sort");
    within(sheet).getByText("Genre");
    within(sheet).getByText("Unwatched only");
  });

  it("above 48rem: Sort/Genre/Unwatched are inline and no Filters control exists", async () => {
    setViewport("desktop");
    renderLibrary();
    await waitForLibraryReady();

    expect(screen.queryByRole("button", { name: "Filters" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();

    const filtersRegion = screen.getByLabelText("Library filters");
    within(filtersRegion).getByText("Sort");
    within(filtersRegion).getByText("Genre");
    within(filtersRegion).getByText("Unwatched only");
  });

  it("changing Sort inside the sheet applies the same state change as inline", async () => {
    setViewport("mobile");
    renderLibrary();
    await waitForLibraryReady();

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = await screen.findByRole("dialog", { name: "Filters" });

    // Open the Sort dropdown inside the sheet and pick Recently Added.
    fireEvent.click(within(sheet).getByRole("button", { name: "Sort" }));
    fireEvent.click(await screen.findByRole("option", { name: "Recently Added" }));

    await vi.waitFor(() => {
      const calls = vi.mocked(fetchLibraryItems).mock.calls;
      const last = calls[calls.length - 1]?.[0];
      expect(last?.sort).toBe("added");
    });
  });

  it("Filters control reports the number of active non-default filters", async () => {
    setViewport("mobile");
    renderLibrary();
    await waitForLibraryReady();

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    fireEvent.click(within(sheet).getByLabelText(/Unwatched only/i));
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));

    const filters = await screen.findByRole("button", { name: /Filters/ });
    expect(filters.textContent).toMatch(/1/);
  });

  it("sheet closes on Escape and on the explicit Done control", async () => {
    setViewport("mobile");
    renderLibrary();
    await waitForLibraryReady();

    const filtersBtn = screen.getByRole("button", { name: "Filters" });
    fireEvent.click(filtersBtn);
    await screen.findByRole("dialog", { name: "Filters" });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();

    fireEvent.click(filtersBtn);
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
  });

  it("shows pending text and no Genre dropdown while genres are loading", async () => {
    setViewport("mobile");
    mockLibraryApis({ genresDelay: true });
    renderLibrary();
    await waitForLibraryReady();

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = await screen.findByRole("dialog", { name: "Filters" });

    within(sheet).getByText("Loading genres…");
    expect(within(sheet).queryByRole("button", { name: "Genre" })).toBeNull();
  });

  it("shows error text and no Genre dropdown when genres fail to load", async () => {
    setViewport("mobile");
    mockLibraryApis({ genresReject: true });
    renderLibrary();
    await waitForLibraryReady();

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = await screen.findByRole("dialog", { name: "Filters" });

    within(sheet).getByText("Couldn't load genres.");
    expect(within(sheet).queryByRole("button", { name: "Genre" })).toBeNull();
  });
});
