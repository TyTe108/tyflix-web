// Blocklist tab on the admin console: listing with server-side paging, the
// add form, and the two-click remove path that surfaces Auto-Request warnings.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addToBlocklist,
  fetchBlocklist,
  removeFromBlocklist,
  type AdminBlocklistListResponse,
} from "../api/admin";
import { AdminPage } from "./AdminPage";

vi.mock("../api/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/admin")>();
  return {
    ...actual,
    fetchBlocklist: vi.fn(),
    addToBlocklist: vi.fn(),
    removeFromBlocklist: vi.fn(),
    fetchAdminSystem: vi.fn().mockResolvedValue({}),
    fetchAdminUsers: vi.fn().mockResolvedValue({ users: [], totals: {} }),
    fetchAdminJobs: vi.fn().mockResolvedValue({ jobs: [] }),
    fetchAdminContainers: vi.fn().mockResolvedValue({
      docker: { ok: true, rows: [] },
      native: { rows: [] },
    }),
  };
});

vi.mock("../api/requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/requests")>();
  return {
    ...actual,
    fetchAllRequests: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../api/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/issues")>();
  return {
    ...actual,
    fetchAllIssues: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../api/accessRequests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/accessRequests")>();
  return {
    ...actual,
    fetchAccessRequests: vi.fn().mockResolvedValue({
      requests: [],
      reconciledAt: Date.now(),
    }),
    fetchAccessRequestSections: vi.fn().mockResolvedValue([]),
  };
});

function blocklistPage(
  overrides: Partial<AdminBlocklistListResponse> = {},
): AdminBlocklistListResponse {
  return {
    results: [
      {
        id: 1,
        tmdbId: 603,
        mediaType: "movie",
        title: "The Matrix",
      },
      {
        id: 2,
        tmdbId: 1396,
        mediaType: "tv",
        title: "Breaking Bad",
      },
    ],
    total: 2,
    take: 25,
    skip: 0,
    ...overrides,
  };
}

function renderAdmin(tab?: string) {
  const path = tab ? `/admin?tab=${tab}` : "/admin";
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AdminPage />
    </MemoryRouter>,
  );
}

describe("AdminPage blocklist tab", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.mocked(fetchBlocklist).mockReset();
    vi.mocked(addToBlocklist).mockReset();
    vi.mocked(removeFromBlocklist).mockReset();
    vi.mocked(fetchBlocklist).mockResolvedValue(blocklistPage());
  });

  it("shows a Blocklist tab and selects it via ?tab=blocklist", async () => {
    renderAdmin("blocklist");

    const tab = await screen.findByRole("tab", { name: "Blocklist" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(
      await screen.findByRole("heading", { name: "Blocklist" }),
    ).toBeTruthy();
  });

  it("renders blocklist rows", async () => {
    renderAdmin("blocklist");

    const panel = await screen.findByRole("tabpanel");
    expect(await within(panel).findByText("The Matrix")).toBeTruthy();
    expect(within(panel).getByText("Breaking Bad")).toBeTruthy();
    expect(within(panel).getByText("movie")).toBeTruthy();
    expect(within(panel).getByText("TMDB 603")).toBeTruthy();
  });

  it("renders an empty blocklist as a normal empty state", async () => {
    vi.mocked(fetchBlocklist).mockResolvedValue(
      blocklistPage({ results: [], total: 0 }),
    );
    renderAdmin("blocklist");

    const panel = await screen.findByRole("tabpanel");
    expect(await within(panel).findByText(/no blocklist/i)).toBeTruthy();
    expect(within(panel).queryByRole("alert")).toBeNull();
  });

  it("requests the next page with the correct skip", async () => {
    vi.mocked(fetchBlocklist).mockResolvedValue(
      blocklistPage({
        results: [
          {
            id: 1,
            tmdbId: 603,
            mediaType: "movie",
            title: "The Matrix",
          },
        ],
        total: 30,
        take: 25,
        skip: 0,
      }),
    );

    renderAdmin("blocklist");
    const panel = await screen.findByRole("tabpanel");
    expect(await within(panel).findByText("The Matrix")).toBeTruthy();

    vi.mocked(fetchBlocklist).mockResolvedValue(
      blocklistPage({
        results: [
          {
            id: 3,
            tmdbId: 550,
            mediaType: "movie",
            title: "Fight Club",
          },
        ],
        total: 30,
        take: 25,
        skip: 25,
      }),
    );

    fireEvent.click(within(panel).getByRole("button", { name: /next/i }));

    expect(await within(panel).findByText("Fight Club")).toBeTruthy();
  });

  it("rejects an invalid tmdbId without calling the API", async () => {
    renderAdmin("blocklist");
    const panel = await screen.findByRole("tabpanel");
    await within(panel).findByText("The Matrix");

    const input = within(panel).getByLabelText(/tmdb/i);
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(within(panel).getByRole("button", { name: /add|blocklist/i }));

    expect(within(panel).getByText(/positive integer/i)).toBeTruthy();
    expect(addToBlocklist).not.toHaveBeenCalled();
  });

  it("treats alreadyBlocklisted as a normal success", async () => {
    vi.mocked(addToBlocklist).mockResolvedValue({
      tmdbId: 603,
      mediaType: "movie",
      alreadyBlocklisted: true,
    });

    renderAdmin("blocklist");
    const panel = await screen.findByRole("tabpanel");
    await within(panel).findByText("The Matrix");

    fireEvent.change(within(panel).getByLabelText(/tmdb/i), {
      target: { value: "603" },
    });
    fireEvent.click(
      within(panel).getByRole("button", { name: /^add to blocklist$/i }),
    );

    expect(
      await within(panel).findByText(/already (on the )?blocklist/i),
    ).toBeTruthy();
    expect(addToBlocklist).toHaveBeenCalledWith({
      tmdbId: 603,
      mediaType: "movie",
    });
  });

  it("arming one remove control disarms another", async () => {
    renderAdmin("blocklist");
    const panel = await screen.findByRole("tabpanel");
    await within(panel).findByText("The Matrix");

    const removeButtons = within(panel).getAllByRole("button", {
      name: /^remove$/i,
    });
    fireEvent.click(removeButtons[0]!);

    expect(
      within(panel).getByRole("button", {
        name: /confirm remove|re-request/i,
      }),
    ).toBeTruthy();

    const stillRemove = within(panel).getAllByRole("button", {
      name: /^remove$/i,
    });
    fireEvent.click(stillRemove[0]!);

    const confirms = within(panel).getAllByRole("button", {
      name: /confirm remove|re-request/i,
    });
    expect(confirms).toHaveLength(1);
    expect(
      within(panel).getAllByRole("button", { name: /^remove$/i }),
    ).toHaveLength(1);
  });

  it("an unarmed remove control calls nothing", async () => {
    renderAdmin("blocklist");
    const panel = await screen.findByRole("tabpanel");
    await within(panel).findByText("The Matrix");

    fireEvent.click(
      within(panel).getAllByRole("button", { name: /^remove$/i })[0]!,
    );

    expect(removeFromBlocklist).not.toHaveBeenCalled();
  });

  it("surfaces removal warnings including the re-request risk", async () => {
    vi.mocked(removeFromBlocklist).mockResolvedValue({
      tmdbId: 603,
      mediaType: "movie",
      mediaRowDeleted: true,
      willBeAutoRequested: true,
      warnings: [
        "Removing a blocklist entry also deletes the Seerr media row, which cascades to that title's request history.",
        "If this title is still on a Plex Watchlist with Auto-Request enabled, plex-watchlist-sync may re-request it within about three minutes.",
      ],
    });

    renderAdmin("blocklist");
    const panel = await screen.findByRole("tabpanel");
    await within(panel).findByText("The Matrix");

    fireEvent.click(
      within(panel).getAllByRole("button", { name: /^remove$/i })[0]!,
    );
    fireEvent.click(
      within(panel).getByRole("button", {
        name: /confirm remove|re-request/i,
      }),
    );

    expect(await within(panel).findByText(/request history/i)).toBeTruthy();
    expect(
      within(panel).getByText(/auto-request|watchlist|re-request/i),
    ).toBeTruthy();
    expect(removeFromBlocklist).toHaveBeenCalledWith("movie", 603);
  });
});
