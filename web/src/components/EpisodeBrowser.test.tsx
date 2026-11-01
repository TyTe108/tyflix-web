// Episode tiles on the title page. fetchEpisodes is mocked, and a location
// probe records where a tile's Play link goes, including enterFullscreen.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { libraryImageUrl } from "../api/library";
import {
  fetchEpisodes,
  type Episode,
  type EpisodesResponse,
} from "../api/watch";
import { EpisodeBrowser } from "./EpisodeBrowser";

vi.mock("../api/watch", () => ({
  fetchEpisodes: vi.fn(),
}));

const fetchEpisodesMock = vi.mocked(fetchEpisodes);

const HARBOR_THUMB = "/library/metadata/501/thumb/11";

const harbor: Episode = {
  ratingKey: "501",
  seasonNumber: 1,
  episodeNumber: 1,
  title: "Harbor Light",
  thumb: HARBOR_THUMB,
  summary: "A light on the water.",
  durationMs: 23 * 60_000,
  airDate: "2024-02-22",
  contentRating: "TV-PG",
  viewOffset: 23 * 30_000,
  viewCount: 1,
};

const missingStill: Episode = {
  ratingKey: "502",
  seasonNumber: 1,
  episodeNumber: 2,
  title: "Missing Still",
  thumb: null,
  summary: "No artwork for this one.",
  durationMs: 22 * 60_000,
  airDate: "2024-03-01",
  contentRating: "TV-PG",
  viewOffset: null,
  viewCount: null,
};

const closedGate: Episode = {
  ratingKey: "503",
  seasonNumber: 1,
  episodeNumber: 3,
  title: "Closed Gate",
  thumb: "/library/metadata/503/thumb/33",
  summary: "The gate stays shut.",
  durationMs: 24 * 60_000,
  airDate: "2024-03-08",
  contentRating: "TV-PG",
  viewOffset: null,
  viewCount: 1,
};

const bareRoom: Episode = {
  ratingKey: "504",
  seasonNumber: 1,
  episodeNumber: 4,
  title: "Bare Room",
  thumb: "/library/metadata/504/thumb/44",
  summary: null,
  durationMs: null,
  airDate: null,
  contentRating: null,
  viewOffset: null,
  viewCount: null,
};

const shortWave: Episode = {
  ratingKey: "505",
  seasonNumber: 1,
  episodeNumber: 5,
  title: "Short Wave",
  thumb: "/library/metadata/505/thumb/55",
  summary: null,
  durationMs: 20_000,
  airDate: "2020-05-01",
  contentRating: "TV-14",
  viewOffset: null,
  viewCount: null,
};

const oddDate: Episode = {
  ratingKey: "506",
  seasonNumber: 1,
  episodeNumber: 6,
  title: "Odd Date",
  thumb: "/library/metadata/506/thumb/66",
  summary: null,
  durationMs: null,
  airDate: "next spring",
  contentRating: "TV-MA",
  viewOffset: null,
  viewCount: null,
};

const longCut: Episode = {
  ratingKey: "507",
  seasonNumber: 1,
  episodeNumber: 7,
  title: "Long Cut",
  thumb: "/library/metadata/507/thumb/77",
  summary: null,
  durationMs: 3_831_083,
  airDate: null,
  contentRating: null,
  viewOffset: null,
  viewCount: null,
};

const untitled: Episode = {
  ratingKey: "508",
  seasonNumber: 1,
  episodeNumber: 8,
  title: "",
  thumb: "/library/metadata/508/thumb/88",
  summary: null,
  durationMs: null,
  airDate: null,
  contentRating: null,
  viewOffset: null,
  viewCount: null,
};

const farPier: Episode = {
  ratingKey: "521",
  seasonNumber: 2,
  episodeNumber: 4,
  title: "Far Pier",
  thumb: "/library/metadata/521/thumb/21",
  summary: "Further down the dock.",
  durationMs: 25 * 60_000,
  airDate: "2025-01-01",
  contentRating: "TV-14",
  viewOffset: null,
  viewCount: null,
};

const nearDock: Episode = {
  ratingKey: "522",
  seasonNumber: 2,
  episodeNumber: 2,
  title: "Near Dock",
  thumb: "/library/metadata/522/thumb/22",
  summary: null,
  durationMs: null,
  airDate: null,
  contentRating: null,
  viewOffset: null,
  viewCount: null,
};

const bonusReel: Episode = {
  ratingKey: "500",
  seasonNumber: 0,
  episodeNumber: 1,
  title: "Bonus Reel",
  thumb: "/library/metadata/500/thumb/00",
  summary: "A short extra.",
  durationMs: 5 * 60_000,
  airDate: "2023-12-01",
  contentRating: "TV-G",
  viewOffset: null,
  viewCount: null,
};

const threeSeasons = [
  bonusReel,
  harbor,
  missingStill,
  closedGate,
  bareRoom,
  shortWave,
  oddDate,
  longCut,
  untitled,
  farPier,
  nearDock,
];

function respond(episodes: Episode[]): EpisodesResponse {
  return {
    showRatingKey: "show",
    episodes,
  };
}

function collapsed(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function LocationProbe() {
  const location = useLocation();
  const state = location.state as { enterFullscreen?: unknown } | null;
  const fullscreen =
    state !== null &&
    typeof state === "object" &&
    state.enterFullscreen === true;
  return (
    <>
      <span data-testid="pathname">{location.pathname}</span>
      <span data-testid="enter-fullscreen">{fullscreen ? "true" : "false"}</span>
    </>
  );
}

function tree(tmdbId: number) {
  return (
    <MemoryRouter>
      <EpisodeBrowser tmdbId={tmdbId} />
      <LocationProbe />
    </MemoryRouter>
  );
}

function renderBrowser(tmdbId: number) {
  return render(tree(tmdbId));
}

describe("EpisodeBrowser", () => {
  afterEach(() => {
    cleanup();
    fetchEpisodesMock.mockReset();
  });

  // jsdom has no scrollIntoView. Opening the Season list runs Dropdown's
  // highlight effect, which calls it.
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("lists Season 1, Season 2, then Specials, and starts on Season 1", async () => {
    fetchEpisodesMock.mockResolvedValue(respond(threeSeasons));
    renderBrowser(7);

    expect(
      await screen.findByRole("heading", { name: "Episodes" }),
    ).toBeTruthy();
    const trigger = screen.getByRole("button", { name: "Season" });
    expect(within(trigger).getByText("Season 1")).toBeTruthy();
    fireEvent.click(trigger);
    expect(
      screen
        .getAllByRole("option")
        .map((option) => collapsed(option.textContent)),
    ).toEqual(["Season 1", "Season 2", "Specials"]);
    expect(screen.queryByRole("link", { name: /Bonus Reel/ })).toBeNull();
  });

  it("defaults to Specials when that is the only season", async () => {
    fetchEpisodesMock.mockResolvedValue(respond([bonusReel]));
    renderBrowser(8);

    const trigger = await screen.findByRole("button", { name: "Season" });
    expect(within(trigger).getByText("Specials")).toBeTruthy();
    expect(screen.getByRole("link", { name: /1\. Bonus Reel/ })).toBeTruthy();
  });

  it("shows only the picked season, in the order the rows arrived", async () => {
    fetchEpisodesMock.mockResolvedValue(respond(threeSeasons));
    renderBrowser(7);

    fireEvent.click(await screen.findByRole("button", { name: "Season" }));
    fireEvent.click(screen.getByRole("option", { name: "Season 2" }));

    const far = screen.getByRole("link", { name: /4\. Far Pier/ });
    const near = screen.getByRole("link", { name: /2\. Near Dock/ });
    expect(
      far.compareDocumentPosition(near) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Harbor Light/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Bonus Reel/ })).toBeNull();
  });

  it("makes the whole tile a Play link with fullscreen state", async () => {
    fetchEpisodesMock.mockResolvedValue(respond(threeSeasons));
    renderBrowser(7);

    const tile = await screen.findByRole("link", { name: /1\. Harbor Light/ });
    fireEvent.click(tile);

    expect(screen.getByTestId("pathname").textContent).toBe(
      "/watch/episode/501",
    );
    expect(screen.getByTestId("enter-fullscreen").textContent).toBe("true");
  });

  it("builds the meta line from the fields that are present", async () => {
    fetchEpisodesMock.mockResolvedValue(respond(threeSeasons));
    renderBrowser(7);

    const harborTile = await screen.findByRole("link", {
      name: /1\. Harbor Light/,
    });
    expect(within(harborTile).getByText("TV-PG · 23m · 2024")).toBeTruthy();

    const longTile = screen.getByRole("link", { name: /7\. Long Cut/ });
    expect(within(longTile).getByText("1h 4m")).toBeTruthy();

    const bareTile = screen.getByRole("link", { name: /4\. Bare Room/ });
    expect(collapsed(bareTile.textContent)).toBe("4. Bare Room");
    expect(bareTile.querySelector(".episode-tile-meta")).toBeNull();

    const shortTile = screen.getByRole("link", { name: /5\. Short Wave/ });
    expect(within(shortTile).getByText("TV-14 · 2020")).toBeTruthy();
    expect(shortTile.textContent).not.toContain("0m");

    const oddTile = screen.getByRole("link", { name: /6\. Odd Date/ });
    expect(within(oddTile).getByText("TV-MA")).toBeTruthy();
    expect(oddTile.textContent).not.toContain("next spring");
  });

  it("uses the episode number when the title is empty", async () => {
    fetchEpisodesMock.mockResolvedValue(respond(threeSeasons));
    renderBrowser(7);

    expect(
      await screen.findByRole("link", { name: /Episode 8/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /8\./ })).toBeNull();
  });

  it("renders a lazy thumb, or the poster placeholder when thumb is null", async () => {
    fetchEpisodesMock.mockResolvedValue(respond(threeSeasons));
    renderBrowser(7);

    const harborTile = await screen.findByRole("link", {
      name: /1\. Harbor Light/,
    });
    const img = harborTile.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      libraryImageUrl(HARBOR_THUMB, "640x360"),
    );
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("loading")).toBe("lazy");

    const missingTile = screen.getByRole("link", { name: /2\. Missing Still/ });
    expect(missingTile.querySelector("img")).toBeNull();
    expect(within(missingTile).getByText("No image")).toBeTruthy();
  });

  // Guards the resized still: the tile asks for 640x360 and offers 1280x720
  // to a dense screen, using the same widths as the tile layout.
  it("requests a 640x360 still and a 1280x720 one for dense screens", async () => {
    fetchEpisodesMock.mockResolvedValue(respond(threeSeasons));
    renderBrowser(7);

    const harborTile = await screen.findByRole("link", {
      name: /1\. Harbor Light/,
    });
    const img = harborTile.querySelector("img");
    const small =
      "/api/library/image?path=%2Flibrary%2Fmetadata%2F501%2Fthumb%2F11&size=640x360";
    const large =
      "/api/library/image?path=%2Flibrary%2Fmetadata%2F501%2Fthumb%2F11&size=1280x720";
    expect(img?.getAttribute("src")).toBe(small);
    expect(img?.getAttribute("srcset")).toBe(`${small} 640w, ${large} 1280w`);
    expect(img?.getAttribute("sizes")).toBe("(max-width: 48rem) 100vw, 19.7rem");
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("loading")).toBe("lazy");
  });

  it("shows a progress bar, a watched tick, or neither", async () => {
    fetchEpisodesMock.mockResolvedValue(respond(threeSeasons));
    renderBrowser(7);

    const harborTile = await screen.findByRole("link", {
      name: /1\. Harbor Light/,
    });
    expect(
      within(harborTile).getByRole("progressbar").getAttribute("aria-valuenow"),
    ).toBe("50");

    const finished = screen.getByRole("link", { name: /3\. Closed Gate/ });
    expect(within(finished).getByLabelText("Watched")).toBeTruthy();
    expect(within(finished).queryByRole("progressbar")).toBeNull();

    const untouched = screen.getByRole("link", { name: /4\. Bare Room/ });
    expect(within(untouched).queryByRole("progressbar")).toBeNull();
    expect(within(untouched).queryByLabelText("Watched")).toBeNull();
  });

  it("shows a summary only when the row has one", async () => {
    fetchEpisodesMock.mockResolvedValue(respond(threeSeasons));
    renderBrowser(7);

    const harborTile = await screen.findByRole("link", {
      name: /1\. Harbor Light/,
    });
    expect(within(harborTile).getByText("A light on the water.")).toBeTruthy();

    const bareTile = screen.getByRole("link", { name: /4\. Bare Room/ });
    expect(collapsed(bareTile.textContent)).toBe("4. Bare Room");
  });

  it("starts a different show on its own default season", async () => {
    fetchEpisodesMock.mockImplementation(async (tmdbId: number) => {
      if (tmdbId === 10) {
        return respond([
          {
            ...harbor,
            ratingKey: "601",
            title: "First Pier",
          },
          {
            ...farPier,
            ratingKey: "602",
            title: "Second Pier",
          },
        ]);
      }
      return respond([
        {
          ...harbor,
          ratingKey: "701",
          title: "New Pier",
        },
        {
          ...farPier,
          ratingKey: "702",
          title: "New Dock",
        },
      ]);
    });

    const view = renderBrowser(10);
    fireEvent.click(await screen.findByRole("button", { name: "Season" }));
    fireEvent.click(screen.getByRole("option", { name: "Season 2" }));
    expect(screen.getByRole("link", { name: /4\. Second Pier/ })).toBeTruthy();

    view.rerender(tree(11));

    expect(
      await screen.findByRole("link", { name: /1\. New Pier/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /New Dock/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Second Pier/ })).toBeNull();
    expect(
      within(screen.getByRole("button", { name: "Season" })).getByText(
        "Season 1",
      ),
    ).toBeTruthy();
  });

  it("shows the server's error and Retry, then the tiles", async () => {
    fetchEpisodesMock
      .mockRejectedValueOnce(new Error("the library is offline"))
      .mockResolvedValueOnce(respond([harbor]));
    renderBrowser(7);

    expect(await screen.findByText("the library is offline")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("No episodes available.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("link", { name: /1\. Harbor Light/ }),
    ).toBeTruthy();
    expect(fetchEpisodesMock).toHaveBeenCalledTimes(2);
  });

  it("shows a loading line before the rows arrive", async () => {
    let resolveList: ((value: EpisodesResponse) => void) | undefined;
    fetchEpisodesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    renderBrowser(7);

    expect(screen.getByText("Loading episodes…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Season" })).toBeNull();

    resolveList?.(respond([harbor]));
    expect(
      await screen.findByRole("link", { name: /1\. Harbor Light/ }),
    ).toBeTruthy();
  });

  it("says when the show has no episodes and hides the dropdown", async () => {
    fetchEpisodesMock.mockResolvedValue(respond([]));
    renderBrowser(7);

    expect(await screen.findByText("No episodes available.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Season" })).toBeNull();
  });
});
