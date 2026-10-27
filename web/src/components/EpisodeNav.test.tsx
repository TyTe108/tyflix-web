// Previous and Next links under the player. Rendered on its own because
// WatchPage needs hls.js, the router, and a descriptor fetch.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { NextEpisode, PreviousEpisode } from "../api/watch";
import { EpisodeNav } from "./EpisodeNav";

const previousEpisode: PreviousEpisode = {
  ratingKey: "201",
  seasonNumber: 1,
  episodeNumber: 1,
  title: "Pilot",
  thumb: null,
};

const nextEpisode: NextEpisode = {
  ratingKey: "203",
  seasonNumber: 1,
  episodeNumber: 3,
  title: "Finale",
  thumb: null,
};

function LocationProbe() {
  const location = useLocation();
  const stateLabel =
    location.state === null
      ? "null"
      : location.state === undefined
        ? "undefined"
        : "set";
  return (
    <>
      <span data-testid="pathname">{location.pathname}</span>
      <span data-testid="location-state">{stateLabel}</span>
    </>
  );
}

function renderNav(props: {
  previous: PreviousEpisode | null;
  next: NextEpisode | null;
}) {
  return render(
    <MemoryRouter initialEntries={["/watch/episode/202"]}>
      <Routes>
        <Route
          path="/watch/episode/:rk"
          element={
            <>
              <EpisodeNav previous={props.previous} next={props.next} />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("EpisodeNav", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing when both neighbors are null", () => {
    const { container } = renderNav({ previous: null, next: null });

    expect(screen.queryByRole("navigation")).toBeNull();
    expect(container.querySelector("nav")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders only the previous link", () => {
    renderNav({ previous: previousEpisode, next: null });

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    const link = screen.getByRole("link", { name: /Previous episode/ });
    expect(link.textContent).toContain("S1E1 · Pilot");
    expect(link.getAttribute("href")).toBe("/watch/episode/201");
    expect(screen.queryByRole("link", { name: /Next episode/ })).toBeNull();
  });

  it("renders only the next link", () => {
    renderNav({ previous: null, next: nextEpisode });

    const link = screen.getByRole("link", { name: /Next episode/ });
    expect(link.className).toContain("watch-episode-nav-link--next");
    expect(link.getAttribute("href")).toBe("/watch/episode/203");
  });

  it("puts the previous link before the next link in one landmark", () => {
    renderNav({ previous: previousEpisode, next: nextEpisode });

    const nav = screen.getByRole("navigation", { name: "Episode navigation" });
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(nav.contains(links[0]!)).toBe(true);
    expect(nav.contains(links[1]!)).toBe(true);
    expect(
      links[0]!.compareDocumentPosition(links[1]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(links[0]!.textContent).toContain("Previous episode");
    expect(links[1]!.textContent).toContain("Next episode");
  });

  it("omits the separator when the title is empty", () => {
    renderNav({
      previous: null,
      next: {
        ratingKey: "202",
        seasonNumber: 1,
        episodeNumber: 2,
        title: "",
        thumb: null,
      },
    });

    const link = screen.getByRole("link", { name: /Next episode/ });
    expect(link.textContent).toContain("S1E2");
    expect(link.textContent).not.toContain("·");
  });

  it("navigates to the next episode without location state", () => {
    renderNav({ previous: null, next: nextEpisode });

    fireEvent.click(screen.getByRole("link", { name: /Next episode/ }));

    expect(screen.getByTestId("pathname").textContent).toBe(
      "/watch/episode/203",
    );
    const stateLabel = screen.getByTestId("location-state").textContent;
    expect(stateLabel === "null" || stateLabel === "undefined").toBe(true);
  });
});
