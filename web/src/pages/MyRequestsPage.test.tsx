// Behavioral tests for MyRequestsPage row navigation (36.4): empty space on a
// request card navigates to the media detail route, while admin action buttons
// on the same card do not.
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMyRequests, type RequestView } from "../api/requests";
import { RequestCard } from "../components/RequestCard";
import { MyRequestsPage } from "./MyRequestsPage";

vi.mock("../api/requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/requests")>();
  return {
    ...actual,
    fetchMyRequests: vi.fn(),
  };
});

vi.mock("../api/me", () => ({
  fetchMyQuota: vi.fn().mockResolvedValue(null),
  formatQuota: () => ({ text: "Unlimited", restricted: false }),
}));

const sampleRequest: RequestView = {
  id: 9,
  tmdbId: 550,
  mediaType: "movie",
  title: "Fight Club",
  posterUrl: null,
  seasons: [],
  requestStatus: "pending",
  mediaStatus: "pending",
  requestedById: 1,
  requestedByName: "Test User",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/requests"]}>
      <LocationProbe />
      <Routes>
        <Route path="/requests" element={<MyRequestsPage />} />
        <Route path="/media/:type/:id" element={<div>media detail</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MyRequestsPage row navigation", () => {
  beforeEach(() => {
    vi.mocked(fetchMyRequests).mockReset();
    vi.mocked(fetchMyRequests).mockResolvedValue([sampleRequest]);
  });

  afterEach(() => {
    cleanup();
  });

  it("navigates to the media detail route when empty row space is clicked", async () => {
    renderPage();
    await screen.findByText("Fight Club");

    expect(screen.getByTestId("location").textContent).toBe("/requests");

    fireEvent.click(screen.getByTestId("request-card-stretch"));

    expect(screen.getByTestId("location").textContent).toBe("/media/movie/550");
  });

  it("does not navigate when an action button on the row is clicked", () => {
    const onApprove = vi.fn();
    const onDecline = vi.fn();

    render(
      <MemoryRouter initialEntries={["/requests"]}>
        <LocationProbe />
        <Routes>
          <Route
            path="/requests"
            element={
              <RequestCard
                request={sampleRequest}
                actions={{
                  onApprove,
                  onDecline,
                  inFlight: false,
                  disabled: false,
                }}
              />
            }
          />
          <Route path="/media/:type/:id" element={<div>media detail</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onApprove).toHaveBeenCalled();
    expect(screen.getByTestId("location").textContent).toBe("/requests");
    expect(screen.queryByText("media detail")).toBeNull();
  });
});
