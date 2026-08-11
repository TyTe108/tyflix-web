// Characterization tests for the mobile bottom tab bar and More sheet
// (MobileNav). AppShell mounts MobileNav below 48rem; these cases drive
// MobileNav directly so sheet open/close and focus behavior stay local.
//
// Viewport control comes from src/test/setup.ts (setViewport). Auth is the
// real AuthProvider with fetchMe mocked at api/auth — same boundary as
// AppShell.test.tsx, since AuthContext is not exported. Badge counts are
// passed in as props (AppShell owns the /api/me/badge-counts poll); sheet
// behavior tests keep counts null / zero so exact accessible names stay valid.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BadgeCounts } from "../api/badgeCounts";
import { fetchMe, type MeResponse } from "../api/auth";
import { AuthProvider } from "../auth/AuthContext";
import { setViewport } from "../test/setup";
import { MobileNav } from "./MobileNav";

vi.mock("../api/auth", () => ({
  fetchMe: vi.fn(),
  logoutRequest: vi.fn(),
}));

const TAB_LABELS = [
  "Library",
  "Discover",
  "Watchlist",
  "My Requests",
  "More",
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

function renderMobileNav(badgeCounts: BadgeCounts | null = null) {
  return render(
    <MemoryRouter initialEntries={["/library"]}>
      <AuthProvider>
        <Routes>
          <Route
            path="*"
            element={<MobileNav badgeCounts={badgeCounts} />}
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function openMoreSheet() {
  const more = screen.getByRole("button", { name: "More" });
  fireEvent.click(more);
  return screen.findByRole("dialog");
}

describe("MobileNav", () => {
  beforeEach(() => {
    setViewport("mobile");
    vi.mocked(fetchMe).mockReset();
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: false }));
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a primary tab bar with Library, Discover, Watchlist, My Requests, and More", async () => {
    renderMobileNav();
    await screen.findByRole("navigation", { name: "Primary" });

    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const label of TAB_LABELS) {
      if (label === "More") {
        within(nav).getByRole("button", { name: label });
      } else {
        within(nav).getByRole("link", { name: label });
      }
    }
    expect(within(nav).getAllByRole("link")).toHaveLength(4);
    within(nav).getByRole("button", { name: "More" });
  });

  it("keeps the More sheet out of the DOM until More is activated", async () => {
    renderMobileNav();
    await screen.findByRole("button", { name: "More" });

    expect(screen.queryByRole("dialog")).toBeNull();

    await openMoreSheet();
    screen.getByRole("dialog");
  });

  it("reveals Home, My Issues, the user name, and Logout in the sheet for a non-admin", async () => {
    renderMobileNav();
    await screen.findByRole("button", { name: "More" });

    const dialog = await openMoreSheet();
    await within(dialog).findByText("Test User");

    within(dialog).getByRole("link", { name: "Home" });
    within(dialog).getByRole("link", { name: "My Issues" });
    within(dialog).getByRole("button", { name: "Logout" });
    expect(within(dialog).queryByRole("link", { name: "Admin" })).toBeNull();
  });

  it("reveals Admin in the sheet for an admin", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: true }));
    renderMobileNav();
    await screen.findByRole("button", { name: "More" });

    const dialog = await openMoreSheet();
    await within(dialog).findByText("Test User");
    within(dialog).getByRole("link", { name: "Admin" });
  });

  it("closes the sheet on Escape and returns focus to More", async () => {
    renderMobileNav();
    const more = await screen.findByRole("button", { name: "More" });
    fireEvent.click(more);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("closes the sheet when a destination inside it is activated", async () => {
    renderMobileNav();
    await screen.findByRole("button", { name: "More" });

    const dialog = await openMoreSheet();
    fireEvent.click(within(dialog).getByRole("link", { name: "Home" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the sheet when the scrim behind it is tapped", async () => {
    renderMobileNav();
    await screen.findByRole("button", { name: "More" });

    await openMoreSheet();
    fireEvent.click(screen.getByTestId("mobile-nav-scrim"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves focus into the sheet on open", async () => {
    renderMobileNav();
    const more = await screen.findByRole("button", { name: "More" });
    fireEvent.click(more);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(more);
  });

  it("badges My Requests on the tab, More as a sheet rollup, and Admin inside the sheet", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: true }));
    renderMobileNav({
      mine: { requests: 2, issues: 1 },
      // Distinct non-zero fields so a rollup that drops one still fails.
      admin: { requests: 2, issues: 3, access: 5 },
    });

    const nav = await screen.findByRole("navigation", { name: "Primary" });
    const requests = within(nav).getByRole("link", { name: /My Requests/ });
    within(requests).getByLabelText("2 requests in progress");

    // More = mine.issues (1) + admin rollup (10) = 11.
    const more = within(nav).getByRole("button", { name: /More/ });
    within(more).getByLabelText("11 items needing attention");

    fireEvent.click(more);
    const dialog = await screen.findByRole("dialog");
    const issues = within(dialog).getByRole("link", { name: /My Issues/ });
    within(issues).getByLabelText("1 open issue");
    const admin = within(dialog).getByRole("link", { name: /Admin/ });
    within(admin).getByLabelText("10 admin items needing attention");
  });
});
