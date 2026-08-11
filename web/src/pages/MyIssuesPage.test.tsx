// Behavioral tests for MyIssuesPage row navigation (36.4): empty space opens
// the issue thread, while the media title link still goes to media detail.
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMyIssues, type IssueView } from "../api/issues";
import { MyIssuesPage } from "./MyIssuesPage";

vi.mock("../api/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/issues")>();
  return {
    ...actual,
    fetchMyIssues: vi.fn(),
  };
});

const sampleIssue: IssueView = {
  id: 42,
  issueType: "audio",
  status: "open",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  media: {
    id: 1,
    tmdbId: 1396,
    mediaType: "tv",
    title: "Breaking Bad",
    posterUrl: null,
  },
  createdBy: {
    id: 1,
    displayName: "Test User",
    plexUsername: "testuser",
  },
  comments: [],
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/issues"]}>
      <LocationProbe />
      <Routes>
        <Route path="/issues" element={<MyIssuesPage />} />
        <Route path="/issues/:id" element={<div>issue detail</div>} />
        <Route path="/media/:type/:id" element={<div>media detail</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MyIssuesPage row navigation", () => {
  beforeEach(() => {
    vi.mocked(fetchMyIssues).mockReset();
    vi.mocked(fetchMyIssues).mockResolvedValue([sampleIssue]);
  });

  afterEach(() => {
    cleanup();
  });

  it("navigates to the issue detail route when empty row space is clicked", async () => {
    renderPage();
    await screen.findByText("Breaking Bad");

    expect(screen.getByTestId("location").textContent).toBe("/issues");

    fireEvent.click(screen.getByTestId("my-issues-stretch"));

    expect(screen.getByTestId("location").textContent).toBe("/issues/42");
  });

  it("does not navigate to the issue when the media title link is clicked", async () => {
    renderPage();
    await screen.findByText("Breaking Bad");

    fireEvent.click(screen.getByRole("link", { name: "Breaking Bad" }));

    expect(screen.getByTestId("location").textContent).toBe("/media/tv/1396");
    expect(screen.queryByText("issue detail")).toBeNull();
  });
});
