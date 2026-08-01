// Characterization test for AppShell's sidebar nav: which links each role sees,
// and when the pending-access badge appears on Admin.
//
// This file is the web harness's proof-of-life (vitest + jsdom + Testing
// Library wired into `npm test -w web`) and the regression net for the mobile
// nav work in 36.1. It deliberately renders the real AppShell inside the real
// AuthProvider — no useAuth mock, no exported context.
//
// Session state is driven by mocking fetchMe at api/auth (AuthProvider's only
// network read on mount). AuthContext is not exported, so that boundary is the
// supported way to put the provider into "authed" without changing production
// code. The pending-count call and its 60s setInterval are mocked at
// api/accessRequests so an admin mount cannot leave a live timer that would
// hang the suite.
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAccessRequestPendingCount } from "../api/accessRequests";
import { fetchMe, type MeResponse } from "../api/auth";
import { AuthProvider } from "../auth/AuthContext";
import { setViewport } from "../test/setup";
import { AppShell } from "./AppShell";

// AuthProvider imports fetchMe / logoutRequest from this module. Replacing the
// whole module keeps AuthProvider real while controlling the session it sees.
vi.mock("../api/auth", () => ({
  fetchMe: vi.fn(),
  logoutRequest: vi.fn(),
}));

// AppShell calls fetchAccessRequestPendingCount on admin mount and again on a
// 60s interval. The mock both supplies the badge number and avoids a real
// timer against a live network.
vi.mock("../api/accessRequests", () => ({
  fetchAccessRequestPendingCount: vi.fn(),
}));

const NON_ADMIN_LABELS = [
  "Library",
  "Home",
  "Discover",
  "Watchlist",
  "My Requests",
  "My Issues",
] as const;

function meResponse(overrides: {
  isAdmin: boolean;
  displayName?: string;
}): MeResponse {
  return {
    isAdmin: overrides.isAdmin,
    user: {
      seerrUserId: 1,
      plexId: 1,
      plexUsername: "testuser",
      displayName: overrides.displayName ?? "Test User",
      avatar: null,
      permissions: overrides.isAdmin ? 2 : 0,
    },
  };
}

function renderAppShell() {
  return render(
    <MemoryRouter initialEntries={["/library"]}>
      <AuthProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/library" element={<div>library outlet</div>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("AppShell", () => {
  beforeEach(() => {
    vi.mocked(fetchMe).mockReset();
    vi.mocked(fetchAccessRequestPendingCount).mockReset();
  });

  afterEach(() => {
    // Unmount clears AppShell's pending-count interval before the next test.
    cleanup();
  });

  it("shows the six non-admin nav links and hides Admin for a non-admin", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: false }));

    renderAppShell();

    // Display name only appears once AuthProvider has applied a successful
    // fetchMe. If the auth mock is missing, this find throws instead of
    // letting an empty anon shell pass the link assertions below.
    await screen.findByText("Test User");

    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(6);

    for (const label of NON_ADMIN_LABELS) {
      within(nav).getByRole("link", { name: label });
    }

    expect(within(nav).queryByRole("link", { name: "Admin" })).toBeNull();
  });

  it("shows Admin in addition to the six non-admin links for an admin", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: true }));
    vi.mocked(fetchAccessRequestPendingCount).mockResolvedValue({ pending: 0 });

    renderAppShell();

    await screen.findByText("Test User");
    const adminLink = await screen.findByRole("link", { name: "Admin" });

    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(7);

    for (const label of NON_ADMIN_LABELS) {
      within(nav).getByRole("link", { name: label });
    }
    expect(adminLink).toBe(within(nav).getByRole("link", { name: "Admin" }));
  });

  it("renders the pending-access badge with the count when pending > 0", async () => {
    // pending: 1 is the boundary the > 0 check must accept. A mutated
    // threshold of > 1 would hide this badge and fail the find below.
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: true }));
    vi.mocked(fetchAccessRequestPendingCount).mockResolvedValue({ pending: 1 });

    renderAppShell();

    await screen.findByText("Test User");

    const badge = await screen.findByLabelText("1 pending access request");
    expect(badge.textContent).toBe("1");
  });

  it("renders the sidebar and not the mobile tab bar above 48rem", async () => {
    setViewport("desktop");
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: false }));

    renderAppShell();
    await screen.findByText("Test User");

    screen.getByRole("complementary");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    within(nav).getByRole("link", { name: "Home" });
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("renders the mobile tab bar and not the sidebar below 48rem", async () => {
    setViewport("mobile");
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: false }));

    renderAppShell();
    await screen.findByRole("button", { name: "More" });

    expect(screen.queryByRole("complementary")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    within(nav).getByRole("link", { name: "Library" });
    within(nav).getByRole("button", { name: "More" });
    expect(within(nav).queryByRole("link", { name: "Home" })).toBeNull();
  });

  it("switches between sidebar and mobile nav when the viewport crosses 48rem", async () => {
    setViewport("desktop");
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: false }));

    renderAppShell();
    await screen.findByText("Test User");
    screen.getByRole("complementary");

    setViewport("mobile");
    await screen.findByRole("button", { name: "More" });
    expect(screen.queryByRole("complementary")).toBeNull();

    setViewport("desktop");
    await screen.findByRole("complementary");
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });
});
