// Back from the player. Rendered on its own because WatchPage needs hls.js,
// the router, and a descriptor fetch.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { BackControl } from "./BackControl";

function HistoryProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="pathname">{location.pathname}</span>
      <button type="button" onClick={() => navigate(-1)}>
        Pop history
      </button>
    </>
  );
}

function renderBack(options: {
  initialEntries: Array<string | { pathname: string; state?: unknown }>;
  initialIndex?: number;
  className: string;
  children: string;
}) {
  return render(
    <MemoryRouter
      initialEntries={options.initialEntries}
      initialIndex={options.initialIndex}
    >
      <HistoryProbe />
      <Routes>
        <Route
          path="/watch/episode/:rk"
          element={
            <BackControl className={options.className}>
              {options.children}
            </BackControl>
          }
        />
        <Route path="/media/tv/:id" element={<span>Title</span>} />
        <Route path="/somewhere" element={<span>Somewhere</span>} />
        <Route path="/" element={<span>Library</span>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("BackControl", () => {
  afterEach(() => {
    cleanup();
  });

  it("pops one entry from an in-app page", () => {
    renderBack({
      initialEntries: ["/media/tv/1", "/watch/episode/2"],
      initialIndex: 1,
      className: "watch-back-link",
      children: "← Back",
    });

    const button = screen.getByRole("button", { name: "← Back" });
    expect(button.className).toBe("watch-back-link");
    expect(screen.queryByRole("link", { name: "← Back" })).toBeNull();

    fireEvent.click(button);

    expect(screen.getByTestId("pathname").textContent).toBe("/media/tv/1");
  });

  it("links home from the first entry", () => {
    renderBack({
      initialEntries: ["/watch/episode/2"],
      className: "watch-back-link",
      children: "← Back",
    });

    const link = screen.getByRole("link", { name: "← Back" });
    expect(link.getAttribute("href")).toBe("/");
    expect(link.className).toBe("watch-back-link");
    expect(screen.queryByRole("button", { name: "← Back" })).toBeNull();

    fireEvent.click(link);

    expect(screen.getByTestId("pathname").textContent).toBe("/");
  });

  it("replaces a landing entry so Back from the Library does not reopen the player", () => {
    renderBack({
      initialEntries: [
        "/somewhere",
        { pathname: "/watch/episode/2", state: { landing: true } },
      ],
      initialIndex: 1,
      className: "watch-back-link",
      children: "← Back",
    });

    const link = screen.getByRole("link", { name: "← Back" });
    expect(link.getAttribute("href")).toBe("/");

    fireEvent.click(link);
    fireEvent.click(screen.getByRole("button", { name: "Pop history" }));

    expect(screen.getByTestId("pathname").textContent).toBe("/somewhere");
  });

  it("pops when the state only looks like a landing marker", () => {
    renderBack({
      initialEntries: [
        "/media/tv/1",
        { pathname: "/watch/episode/2", state: { landing: "true" } },
      ],
      initialIndex: 1,
      className: "watch-back-link",
      children: "← Back",
    });

    expect(screen.getByRole("button", { name: "← Back" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "← Back" })).toBeNull();
  });

  it("renders the error-state label as a button on an in-app entry", () => {
    renderBack({
      initialEntries: ["/media/tv/1", "/watch/episode/2"],
      initialIndex: 1,
      className: "btn secondary",
      children: "Back",
    });

    const button = screen.getByRole("button", { name: "Back" });
    expect(button.classList.contains("btn")).toBe(true);
    expect(button.classList.contains("secondary")).toBe(true);
  });
});
