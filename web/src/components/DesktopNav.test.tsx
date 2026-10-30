// Characterization tests for the desktop top bar and menu drawer (DesktopNav).
// AppShell mounts DesktopNav at 48rem and up; these cases drive DesktopNav
// directly so the drawer, the account link, and the scrolled class stay local.
//
// Auth is the real AuthProvider with fetchMe and logoutRequest mocked at
// api/auth, the same boundary as MobileNav.test.tsx, since AuthContext is not
// exported. Badge counts are passed in as props (AppShell owns the
// /api/me/badge-counts poll). Link tests that don't care about badges pass
// null so exact accessible names stay valid.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BadgeCounts } from "../api/badgeCounts";
import { fetchMe, logoutRequest, type MeResponse } from "../api/auth";
import { AuthProvider } from "../auth/AuthContext";
import { DesktopNav } from "./DesktopNav";

vi.mock("../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/auth")>();
  return {
    ...actual,
    fetchMe: vi.fn(),
    logoutRequest: vi.fn(),
  };
});

const NON_ADMIN_LINKS = [
  ["Library", "/library"],
  ["Home", "/home"],
  ["Discover", "/discover"],
  ["Watchlist", "/watchlist"],
  ["My Requests", "/requests"],
  ["My Issues", "/issues"],
  ["Settings", "/settings"],
] as const;

const originalScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");

let restoreScrollSpies: (() => void) | null = null;

function meResponse(overrides: {
  isAdmin?: boolean;
  displayName?: string;
  plexUsername?: string;
} = {}): MeResponse {
  return {
    isAdmin: overrides.isAdmin ?? false,
    user: {
      seerrUserId: 1,
      plexId: 1,
      plexUsername: overrides.plexUsername ?? "testuser",
      displayName: overrides.displayName ?? "Test User",
      avatar: null,
      permissions: overrides.isAdmin ? 2 : 0,
    },
    preferences: { fullscreenOnPlay: true },
  };
}

function renderDesktopNav(
  badgeCounts: BadgeCounts | null = null,
  initialPath = "/library",
) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route
            path="*"
            element={<DesktopNav badgeCounts={badgeCounts} />}
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function setScrollY(value: number) {
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    value,
  });
}

async function openMenu() {
  const menu = screen.getByRole("button", { name: /^Menu/ });
  fireEvent.click(menu);
  const dialog = await screen.findByRole("dialog", { name: "Menu" });
  return { menu, dialog };
}

function expectMenuClosed(menu: HTMLElement) {
  expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
  expect(document.activeElement).toBe(menu);
  expect(menu.getAttribute("aria-expanded")).toBe("false");
}

describe("DesktopNav", () => {
  beforeEach(() => {
    vi.mocked(fetchMe).mockReset();
    vi.mocked(logoutRequest).mockReset();
    vi.mocked(logoutRequest).mockResolvedValue(undefined);
    vi.mocked(fetchMe).mockResolvedValue(meResponse());
  });

  afterEach(() => {
    cleanup();
    restoreScrollSpies?.();
    restoreScrollSpies = null;
    if (originalScrollY) {
      Object.defineProperty(window, "scrollY", originalScrollY);
    }
  });

  it("renders the menu button, the wordmark, and the account initial", async () => {
    renderDesktopNav();

    const menu = screen.getByRole("button", { name: "Menu" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(menu.getAttribute("aria-haspopup")).toBe("dialog");
    expect(menu.getAttribute("aria-controls")).toBeNull();
    expect(menu.getAttribute("type")).toBe("button");

    const wordmark = screen.getByRole("link", { name: "Tyflix" });
    expect(wordmark.getAttribute("href")).toBe("/library");

    const account = await screen.findByRole("link", {
      name: "Account settings, Test User",
    });
    expect(account.getAttribute("href")).toBe("/settings");
    expect(account.textContent).toBe("T");
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
  });

  it("renders the menu button and wordmark with no account link while fetchMe is pending", () => {
    vi.mocked(fetchMe).mockReturnValue(new Promise(() => {}));
    renderDesktopNav();

    screen.getByRole("button", { name: "Menu" });
    screen.getByRole("link", { name: "Tyflix" });
    expect(screen.queryByRole("link", { name: /^Account settings/ })).toBeNull();
  });

  it("uses a trimmed display name and its first letter for the account link", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ displayName: "  zoe" }));
    renderDesktopNav();

    const account = await screen.findByRole("link", {
      name: "Account settings, zoe",
    });
    expect(account.textContent).toBe("Z");
  });

  it("falls back to the plex username when the display name is blank", async () => {
    vi.mocked(fetchMe).mockResolvedValue(
      meResponse({ displayName: "", plexUsername: "testuser" }),
    );
    renderDesktopNav();

    const account = await screen.findByRole("link", {
      name: "Account settings, testuser",
    });
    expect(account.textContent).toBe("T");
  });

  it("treats a display name of only spaces as blank and uses the plex username", async () => {
    vi.mocked(fetchMe).mockResolvedValue(
      meResponse({ displayName: "   ", plexUsername: "testuser" }),
    );
    renderDesktopNav();

    const account = await screen.findByRole("link", {
      name: "Account settings, testuser",
    });
    expect(account.textContent).toBe("T");
  });

  it("names the account link Account settings and shows no letter when both names are blank", async () => {
    vi.mocked(fetchMe).mockResolvedValue(
      meResponse({ displayName: "", plexUsername: "" }),
    );
    renderDesktopNav();

    const account = await screen.findByRole("link", { name: "Account settings" });
    expect(account.textContent).toBe("");
  });

  it("uses the first code point of the display name as the initial", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ displayName: "😀 Fan" }));
    renderDesktopNav();

    const account = await screen.findByRole("link", {
      name: "Account settings, 😀 Fan",
    });
    expect(account.textContent).toBe("😀");
  });

  it("names the menu button Menu and shows no dot when nothing needs attention", () => {
    const { unmount } = renderDesktopNav(null);
    screen.getByRole("button", { name: "Menu" });
    expect(screen.queryByTestId("menu-attention-dot")).toBeNull();
    unmount();

    renderDesktopNav({
      mine: { requests: 0, issues: 0 },
      admin: { requests: 0, issues: 0, access: 0 },
    });
    screen.getByRole("button", { name: "Menu" });
    expect(screen.queryByTestId("menu-attention-dot")).toBeNull();
  });

  it("names the menu button for one item and shows the attention dot", () => {
    renderDesktopNav({
      mine: { requests: 1, issues: 0 },
      admin: { requests: 0, issues: 0, access: 0 },
    });

    screen.getByRole("button", { name: "Menu, 1 item needing attention" });
    const dot = screen.getByTestId("menu-attention-dot");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
  });

  it("rolls mine and every admin field into the menu button name", () => {
    renderDesktopNav({
      mine: { requests: 2, issues: 1 },
      admin: { requests: 2, issues: 3, access: 5 },
    });

    screen.getByRole("button", { name: "Menu, 13 items needing attention" });
    screen.getByTestId("menu-attention-dot");
  });

  it("counts only mine when admin is null", () => {
    renderDesktopNav({
      mine: { requests: 2, issues: 1 },
      admin: null,
    });

    screen.getByRole("button", { name: "Menu, 3 items needing attention" });
    screen.getByTestId("menu-attention-dot");
  });

  it("opens the menu drawer on the current route with non-admin links in order", async () => {
    renderDesktopNav(null, "/discover");
    await screen.findByRole("link", { name: "Account settings, Test User" });
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close menu" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();

    const menu = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(menu);
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);

    const nav = within(dialog).getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(NON_ADMIN_LINKS.length);
    links.forEach((link, index) => {
      const [label, href] = NON_ADMIN_LINKS[index];
      expect(link.textContent).toBe(label);
      expect(link.getAttribute("href")).toBe(href);
      expect(link.querySelector("svg")).toBeNull();
      if (label === "Discover") {
        expect(link.classList.contains("active")).toBe(true);
        expect(link.getAttribute("aria-current")).toBe("page");
      } else {
        expect(link.classList.contains("active")).toBe(false);
        expect(link.getAttribute("aria-current")).toBeNull();
      }
    });
    expect(within(nav).queryByRole("link", { name: "Admin" })).toBeNull();
  });

  it("includes Admin for an admin", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: true }));
    renderDesktopNav(null, "/discover");
    await screen.findByRole("link", { name: "Account settings, Test User" });

    const { dialog } = await openMenu();
    const nav = within(dialog).getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(NON_ADMIN_LINKS.length + 1);
    expect(links[links.length - 1].textContent).toBe("Admin");
    expect(links[links.length - 1].getAttribute("href")).toBe("/admin");
  });

  it("badges My Requests, My Issues, and Admin with today's labels", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: true }));
    renderDesktopNav({
      mine: { requests: 3, issues: 1 },
      admin: { requests: 2, issues: 3, access: 5 },
    });
    await screen.findByRole("link", { name: "Account settings, Test User" });

    const { dialog } = await openMenu();
    const requests = within(dialog).getByRole("link", { name: /My Requests/ });
    expect(
      within(requests).getByLabelText("3 requests in progress").textContent,
    ).toBe("3");
    const issues = within(dialog).getByRole("link", { name: /My Issues/ });
    expect(within(issues).getByLabelText("1 open issue").textContent).toBe("1");
    const admin = within(dialog).getByRole("link", { name: /Admin/ });
    expect(
      within(admin).getByLabelText("10 admin items needing attention")
        .textContent,
    ).toBe("10");
  });

  it("caps a drawer badge at 99+", async () => {
    renderDesktopNav({
      mine: { requests: 100, issues: 0 },
      admin: null,
    });
    await screen.findByRole("link", { name: "Account settings, Test User" });

    const { dialog } = await openMenu();
    const requests = within(dialog).getByRole("link", { name: /My Requests/ });
    expect(
      within(requests).getByLabelText("100 requests in progress").textContent,
    ).toBe("99+");
  });

  it("shows the display name and an admin chip for an admin", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ isAdmin: true }));
    renderDesktopNav();
    await screen.findByRole("link", { name: "Account settings, Test User" });

    const { dialog } = await openMenu();
    const close = within(dialog).getByRole("button", { name: "Close menu" });
    const nav = within(dialog).getByRole("navigation", { name: "Primary" });
    const name = within(dialog).getByText("Test User");
    const logout = within(dialog).getByRole("button", { name: "Logout" });
    within(dialog).getByText("admin");
    expect(dialog.querySelector(".nav-drawer-divider")).not.toBeNull();

    const following = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(close.compareDocumentPosition(nav) & following).toBeTruthy();
    expect(nav.compareDocumentPosition(name) & following).toBeTruthy();
    expect(name.compareDocumentPosition(logout) & following).toBeTruthy();
  });

  it("shows the display name and no admin chip for a non-admin", async () => {
    renderDesktopNav();
    await screen.findByRole("link", { name: "Account settings, Test User" });

    const { dialog } = await openMenu();
    within(dialog).getByText("Test User");
    expect(within(dialog).queryByText("admin")).toBeNull();
  });

  it("closes the drawer and calls logout once from Logout", async () => {
    renderDesktopNav();
    await screen.findByRole("link", { name: "Account settings, Test User" });

    const { dialog } = await openMenu();
    await act(async () => {
      within(dialog).getByRole("button", { name: "Logout" }).click();
    });
    expect(vi.mocked(logoutRequest)).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
  });

  it("closes on Escape and returns focus to the menu button", async () => {
    renderDesktopNav();
    await screen.findByRole("link", { name: "Account settings, Test User" });

    const { menu, dialog } = await openMenu();
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expectMenuClosed(menu);
  });

  it("closes when the scrim is clicked and returns focus to the menu button", async () => {
    renderDesktopNav();
    await screen.findByRole("link", { name: "Account settings, Test User" });

    const { menu } = await openMenu();
    fireEvent.click(screen.getByTestId("nav-drawer-scrim"));
    expectMenuClosed(menu);
  });

  it("closes from Close menu and returns focus to the menu button", async () => {
    renderDesktopNav();
    await screen.findByRole("link", { name: "Account settings, Test User" });

    const { menu, dialog } = await openMenu();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close menu" }));
    expectMenuClosed(menu);
  });

  it("closes when a drawer link is clicked and returns focus to the menu button", async () => {
    renderDesktopNav();
    await screen.findByRole("link", { name: "Account settings, Test User" });

    const { menu, dialog } = await openMenu();
    fireEvent.click(within(dialog).getByRole("link", { name: "Home" }));
    expectMenuClosed(menu);
  });

  it("stays open when the panel itself is clicked", async () => {
    renderDesktopNav();
    await screen.findByRole("link", { name: "Account settings, Test User" });

    const { menu, dialog } = await openMenu();
    fireEvent.click(dialog);
    expect(screen.getByRole("dialog", { name: "Menu" })).toBe(dialog);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles topbar--scrolled from the window scroll position", () => {
    setScrollY(0);
    renderDesktopNav();
    expect(document.querySelector(".topbar")?.className).toBe("topbar");

    setScrollY(9);
    fireEvent.scroll(window);
    expect(document.querySelector(".topbar")?.className).toBe(
      "topbar topbar--scrolled",
    );

    setScrollY(0);
    fireEvent.scroll(window);
    expect(document.querySelector(".topbar")?.className).toBe("topbar");

    setScrollY(8);
    fireEvent.scroll(window);
    expect(document.querySelector(".topbar")?.className).toBe("topbar");
  });

  it("marks the bar scrolled on mount when the page is already scrolled", () => {
    setScrollY(120);
    renderDesktopNav();
    expect(document.querySelector(".topbar")?.className).toBe(
      "topbar topbar--scrolled",
    );
  });

  it("removes the same scroll listener it added", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    restoreScrollSpies = () => {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    };

    const view = renderDesktopNav();
    const scrollAdds = addSpy.mock.calls.filter((call) => call[0] === "scroll");
    expect(scrollAdds).toHaveLength(1);
    const listener = scrollAdds[0][1];
    expect(scrollAdds[0][2]).toEqual({ passive: true });

    view.unmount();
    expect(removeSpy).toHaveBeenCalledWith("scroll", listener);
  });
});
