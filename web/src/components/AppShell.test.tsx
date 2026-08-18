// Characterization test for AppShell's sidebar nav: which links each role sees,
// and when badges appear on My Requests, My Issues, and Admin.
//
// This file is the web harness's proof-of-life (vitest + jsdom + Testing
// Library wired into `npm test -w web`) and the regression net for the mobile
// nav work in 36.1. It deliberately renders the real AppShell inside the real
// AuthProvider — no useAuth mock, no exported context.
//
// Session state is driven by mocking fetchMe at api/auth (AuthProvider's only
// network read on mount). AuthContext is not exported, so that boundary is the
// supported way to put the provider into "authed" without changing production
// code. The badge-count call and its 60s setInterval are mocked at
// api/badgeCounts so any signed-in mount cannot leave a live timer that would
// hang the suite. Link-inventory and viewport tests keep every count at 0 so
// exact accessible-name assertions stay valid; badge-specific tests alone use
// regex names when a badge's aria-label joins the link's accessible name.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBadgeCounts, type BadgeCounts } from "../api/badgeCounts";
import { fetchMe, type MeResponse } from "../api/auth";
import { AuthProvider } from "../auth/AuthContext";
import { setViewport } from "../test/setup";
import { AppShell } from "./AppShell";

// AuthProvider imports fetchMe / logoutRequest from this module. Replacing the
// whole module keeps AuthProvider real while controlling the session it sees.
vi.mock("../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/auth")>();
  return {
    ...actual,
    fetchMe: vi.fn(),
    logoutRequest: vi.fn(),
  };
});

// AppShell calls fetchBadgeCounts on every signed-in mount and again on a 60s
// interval. Keep the real helpers (adminBadgeRollup) while replacing only the
// network call so mounts cannot leave a live timer against a live network.
vi.mock("../api/badgeCounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/badgeCounts")>();
  return {
    ...actual,
    fetchBadgeCounts: vi.fn(),
  };
});

const NON_ADMIN_LABELS = [
  "Library",
  "Home",
  "Discover",
  "Watchlist",
  "My Requests",
  "My Issues",
] as const;

const ZERO_COUNTS: BadgeCounts = {
  mine: { requests: 0, issues: 0 },
  admin: { requests: 0, issues: 0, access: 0 },
};

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
    preferences: { fullscreenOnPlay: true },
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
    vi.mocked(fetchBadgeCounts).mockReset();
    // Every AppShell mount polls; default to zeros so link-inventory tests keep
    // exact accessible names and no test leaves an unresolved fetch behind.
    vi.mocked(fetchBadgeCounts).mockResolvedValue(ZERO_COUNTS);
  });

  afterEach(() => {
    // Unmount clears AppShell's badge-count interval before the next test.
    cleanup();
  });

  it("shows the six non-admin nav links and hides Admin for a non-admin", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: false }));
    vi.mocked(fetchBadgeCounts).mockResolvedValue({
      mine: { requests: 0, issues: 0 },
      admin: null,
    });

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

  it("renders My Requests, My Issues, and Admin badges with the right counts and labels", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: true }));
    vi.mocked(fetchBadgeCounts).mockResolvedValue({
      mine: { requests: 3, issues: 1 },
      admin: { requests: 2, issues: 3, access: 5 },
    });

    renderAppShell();

    await screen.findByText("Test User");

    const requestsBadge = await screen.findByLabelText(
      "3 requests in progress",
    );
    expect(requestsBadge.textContent).toBe("3");

    const issuesBadge = screen.getByLabelText("1 open issue");
    expect(issuesBadge.textContent).toBe("1");

    // 2 + 3 + 5 — a badge that only reflected one of the three fields fails.
    const adminBadge = screen.getByLabelText(
      "10 admin items needing attention",
    );
    expect(adminBadge.textContent).toBe("10");
  });

  it("renders no badge when every count is 0", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: true }));

    renderAppShell();

    await screen.findByText("Test User");
    await screen.findByRole("link", { name: "Admin" });

    expect(screen.queryByLabelText(/in progress/)).toBeNull();
    expect(screen.queryByLabelText(/open issue/)).toBeNull();
    expect(screen.queryByLabelText(/needing attention/)).toBeNull();
  });

  it("caps badge text at 99+", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: true }));
    vi.mocked(fetchBadgeCounts).mockResolvedValue({
      mine: { requests: 100, issues: 0 },
      admin: { requests: 0, issues: 0, access: 0 },
    });

    renderAppShell();

    await screen.findByText("Test User");
    const badge = await screen.findByLabelText("100 requests in progress");
    expect(badge.textContent).toBe("99+");
  });

  it("renders no badge and no error text when the badge fetch rejects", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: true }));
    vi.mocked(fetchBadgeCounts).mockRejectedValue(new Error("upstream down"));

    renderAppShell();

    await screen.findByText("Test User");
    await screen.findByRole("link", { name: "Admin" });

    expect(screen.queryByLabelText(/in progress/)).toBeNull();
    expect(screen.queryByLabelText(/open issue/)).toBeNull();
    expect(screen.queryByLabelText(/needing attention/)).toBeNull();
    expect(screen.queryByText(/upstream down/i)).toBeNull();
    expect(screen.queryByText(/error/i)).toBeNull();
  });

  it("badges My Requests and My Issues for a non-admin without an Admin row", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: false }));
    vi.mocked(fetchBadgeCounts).mockResolvedValue({
      mine: { requests: 2, issues: 4 },
      admin: null,
    });

    renderAppShell();

    await screen.findByText("Test User");

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).queryByRole("link", { name: /Admin/ })).toBeNull();

    expect(
      (await screen.findByLabelText("2 requests in progress")).textContent,
    ).toBe("2");
    expect(screen.getByLabelText("4 open issues").textContent).toBe("4");
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

// Module-level so a remount increments past 1; reset in beforeEach.
let outletMountCount = 0;

function OutletMountProbe() {
  useEffect(() => {
    outletMountCount += 1;
  }, []);
  return <video data-testid="outlet-probe-video" />;
}

describe("AppShell outlet identity across breakpoint", () => {
  beforeEach(() => {
    outletMountCount = 0;
    vi.mocked(fetchMe).mockReset();
    vi.mocked(fetchBadgeCounts).mockReset();
    vi.mocked(fetchBadgeCounts).mockResolvedValue(ZERO_COUNTS);
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the routed page mounted when the viewport crosses 48rem either way", async () => {
    setViewport("desktop");
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: false }));

    render(
      <MemoryRouter initialEntries={["/library"]}>
        <AuthProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/library" element={<OutletMountProbe />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Test User");
    const videoBefore = screen.getByTestId("outlet-probe-video");
    expect(outletMountCount).toBe(1);

    act(() => {
      setViewport("mobile");
    });
    await screen.findByRole("button", { name: "More" });
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getByTestId("outlet-probe-video")).toBe(videoBefore);
    expect(outletMountCount).toBe(1);

    act(() => {
      setViewport("desktop");
    });
    await screen.findByRole("complementary");
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    expect(screen.getByTestId("outlet-probe-video")).toBe(videoBefore);
    expect(outletMountCount).toBe(1);
  });
});
