// Blocklist tab on the admin console: listing with server-side paging, the
// add form, and the two-click remove path that surfaces Auto-Request warnings.
// Also covers the admin tab-strip dots driven by GET /api/me/badge-counts.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addToBlocklist,
  fetchBlocklist,
  removeFromBlocklist,
  type AdminBlocklistListResponse,
} from "../api/admin";
import {
  approveAccessRequest,
  fetchAccessRequestSections,
  fetchAccessRequests,
  type AccessRequestView,
} from "../api/accessRequests";
import { fetchBadgeCounts, type BadgeCounts } from "../api/badgeCounts";
import {
  approveRequest,
  fetchAllRequests,
  type RequestView,
} from "../api/requests";
import {
  fetchTransmission,
  fetchTransmissionDetail,
  startTransmissionTorrent,
  stopTransmissionTorrent,
  type TransmissionListResponse,
  type TransmissionTorrentDetail,
  type TransmissionTorrentView,
} from "../api/transmission";
import { useTransmissionEnabled } from "../hooks/useTransmissionEnabled";
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
    approveRequest: vi.fn(),
    declineRequest: vi.fn(),
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
    approveAccessRequest: vi.fn(),
    denyAccessRequest: vi.fn(),
  };
});

// AdminPage polls fetchBadgeCounts at the page level. Keep adminBadgeRollup
// real; replace only the network call so every mount has a resolved mock.
vi.mock("../api/badgeCounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/badgeCounts")>();
  return {
    ...actual,
    fetchBadgeCounts: vi.fn(),
  };
});

vi.mock("../api/transmission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/transmission")>();
  return {
    ...actual,
    fetchTransmission: vi.fn(),
    fetchTransmissionDetail: vi.fn(),
    startTransmissionTorrent: vi.fn(),
    stopTransmissionTorrent: vi.fn(),
  };
});

vi.mock("../hooks/useTransmissionEnabled", () => ({
  useTransmissionEnabled: vi.fn(),
}));

const ZERO_BADGE_COUNTS: BadgeCounts = {
  mine: { requests: 0, issues: 0 },
  admin: { requests: 0, issues: 0, access: 0 },
};

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

function transmissionTorrent(
  overrides: Partial<TransmissionTorrentView> = {},
): TransmissionTorrentView {
  return {
    hash: "abc123",
    name: "Example.Show.S01E01",
    labels: ["tv-sonarr"],
    state: "downloading",
    status: 4,
    isStalled: false,
    progress: 0.5,
    sizeBytes: 2 * 1024 ** 3,
    downloadedBytes: 1024 ** 3,
    uploadedBytes: 128 * 1024 ** 2,
    ratio: 0.125,
    rateDownload: 1024 ** 2,
    rateUpload: 128 * 1024,
    etaSeconds: null,
    peers: { connected: 8, sendingToUs: 3, gettingFromUs: 0 },
    error: null,
    queuePosition: 1,
    downloadDir: "/downloads",
    addedAtMs: 1_700_000_000_000,
    doneAtMs: null,
    recheckProgress: 0,
    metadataPercentComplete: 1,
    ...overrides,
  };
}

function transmissionResponse(
  torrents: TransmissionTorrentView[] = [transmissionTorrent()],
): TransmissionListResponse {
  return {
    torrents,
    session: {
      torrentCount: torrents.length,
      activeCount: torrents.length,
      pausedCount: 0,
      rateDownload: 1024 ** 2,
      rateUpload: 128 * 1024,
    },
  };
}

function transmissionDetail(
  overrides: Partial<TransmissionTorrentDetail> = {},
): TransmissionTorrentDetail {
  return {
    hash: "abc123",
    name: "Example.Show.S01E01",
    info: {
      totalSizeBytes: 2_000_000,
      pieceCount: 2,
      pieceSizeBytes: 1_000_000,
      isPrivate: false,
      comment: "",
      creator: "fixture",
      createdAtMs: null,
      addedAtMs: 1_700_000_000_000,
      doneAtMs: null,
      lastActivityAtMs: null,
      downloadDir: "/downloads",
      downloadedBytes: 1_000_000,
      uploadedBytes: 0,
      corruptBytes: 0,
      haveValidBytes: 1_000_000,
      secondsDownloading: 60,
      secondsSeeding: 0,
      errorMessage: null,
    },
    files: [],
    peers: [],
    trackers: [],
    ...overrides,
  };
}

describe("AdminPage Downloads tab", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.mocked(fetchBadgeCounts).mockReset();
    vi.mocked(fetchBadgeCounts).mockResolvedValue(ZERO_BADGE_COUNTS);
    vi.mocked(fetchAllRequests).mockReset();
    vi.mocked(fetchAllRequests).mockResolvedValue([]);
    vi.mocked(fetchTransmission).mockReset();
    vi.mocked(fetchTransmission).mockResolvedValue(transmissionResponse());
    vi.mocked(fetchTransmissionDetail).mockReset();
    vi.mocked(fetchTransmissionDetail).mockResolvedValue(transmissionDetail());
    vi.mocked(startTransmissionTorrent).mockReset();
    vi.mocked(stopTransmissionTorrent).mockReset();
    vi.mocked(startTransmissionTorrent).mockResolvedValue(
      transmissionTorrent({ state: "downloading", status: 4 }),
    );
    vi.mocked(stopTransmissionTorrent).mockResolvedValue(
      transmissionTorrent({ state: "stopped", status: 0 }),
    );
    vi.mocked(useTransmissionEnabled).mockReset();
  });

  it("omits Downloads when transmissionEnabled is false", async () => {
    vi.mocked(useTransmissionEnabled).mockReturnValue(false);
    renderAdmin();

    await screen.findByRole("heading", { name: "Requests" });
    expect(screen.queryByRole("tab", { name: "Downloads" })).toBeNull();
  });

  it("shows Downloads when transmissionEnabled is true", async () => {
    vi.mocked(useTransmissionEnabled).mockReturnValue(true);
    renderAdmin();

    expect(
      await screen.findByRole("tab", { name: "Downloads" }),
    ).toBeTruthy();
  });

  it("falls back to the default tab for a bookmarked Downloads URL when disabled", async () => {
    vi.mocked(useTransmissionEnabled).mockReturnValue(false);
    renderAdmin("downloads");

    const requestsTab = await screen.findByRole("tab", { name: "Requests" });
    expect(requestsTab.getAttribute("aria-selected")).toBe("true");
    expect(
      await screen.findByRole("heading", { name: "Requests" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Downloads" })).toBeNull();
  });

  it("renders unknown remaining time when etaSeconds is null", async () => {
    vi.mocked(useTransmissionEnabled).mockReturnValue(true);
    renderAdmin("downloads");

    expect(
      await screen.findByText("remaining time unknown"),
    ).toBeTruthy();
  });

  it("paints active and inactive progress fills differently", async () => {
    vi.mocked(useTransmissionEnabled).mockReturnValue(true);
    vi.mocked(fetchTransmission).mockResolvedValue(
      transmissionResponse([
        transmissionTorrent({
          hash: "seeding-hash",
          name: "Seeding.Torrent",
          state: "seeding",
          queuePosition: 0,
        }),
        transmissionTorrent({
          hash: "stopped-hash",
          name: "Stopped.Torrent",
          state: "stopped",
          queuePosition: 1,
        }),
      ]),
    );
    renderAdmin("downloads");

    const seeding = await screen.findByRole("progressbar", {
      name: "Seeding.Torrent progress",
    });
    const stopped = screen.getByRole("progressbar", {
      name: "Stopped.Torrent progress",
    });

    const seedingFill = seeding.querySelector("span");
    const stoppedFill = stopped.querySelector("span");
    expect(seedingFill?.className).toBeTruthy();
    expect(stoppedFill?.className).toBeTruthy();
    expect(seedingFill?.className).not.toBe(stoppedFill?.className);
    expect(seedingFill?.classList.contains("is-active")).toBe(true);
    expect(stoppedFill?.classList.contains("is-idle")).toBe(true);
  });

  it("paints an errored row's progress fill as an error regardless of state", async () => {
    vi.mocked(useTransmissionEnabled).mockReturnValue(true);
    vi.mocked(fetchTransmission).mockResolvedValue(
      transmissionResponse([
        transmissionTorrent({
          state: "downloading",
          error: { code: 3, message: "Tracker gave an error" },
        }),
      ]),
    );
    renderAdmin("downloads");

    const bar = await screen.findByRole("progressbar", {
      name: "Example.Show.S01E01 progress",
    });
    const fill = bar.querySelector("span");
    expect(fill?.classList.contains("is-error")).toBe(true);
    expect(fill?.classList.contains("is-active")).toBe(false);
  });

  it("shows a torrent error message instead of normal transfer status", async () => {
    vi.mocked(useTransmissionEnabled).mockReturnValue(true);
    vi.mocked(fetchTransmission).mockResolvedValue(
      transmissionResponse([
        transmissionTorrent({
          error: { code: 3, message: "Tracker gave an error" },
        }),
      ]),
    );
    renderAdmin("downloads");

    const message = await screen.findByText("Tracker gave an error");
    expect(message.classList.contains("error")).toBe(true);
    expect(screen.queryByText(/Downloading from/)).toBeNull();
  });

  it("fetches detail only after its row is expanded", async () => {
    vi.mocked(useTransmissionEnabled).mockReturnValue(true);
    renderAdmin("downloads");

    const expand = await screen.findByRole("button", {
      name: "Expand Example.Show.S01E01 details",
    });
    expect(fetchTransmissionDetail).not.toHaveBeenCalled();

    fireEvent.click(expand);

    await screen.findByRole("heading", { name: "Info" });
    expect(fetchTransmissionDetail).toHaveBeenCalledTimes(1);
    expect(fetchTransmissionDetail).toHaveBeenCalledWith("abc123");
  });

  it("renders the normal empty state for a torrent with no connected peers", async () => {
    vi.mocked(useTransmissionEnabled).mockReturnValue(true);
    vi.mocked(fetchTransmissionDetail).mockResolvedValue(
      transmissionDetail({ peers: [] }),
    );
    renderAdmin("downloads");

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Expand Example.Show.S01E01 details",
      }),
    );

    expect(await screen.findByText("No connected peers")).toBeTruthy();
  });

  it("renders Start for stopped rows and Stop for seeding rows", async () => {
    vi.mocked(useTransmissionEnabled).mockReturnValue(true);
    vi.mocked(fetchTransmission).mockResolvedValue(
      transmissionResponse([
        transmissionTorrent({
          hash: "stopped-hash",
          name: "Stopped.Torrent",
          state: "stopped",
          status: 0,
          queuePosition: 0,
        }),
        transmissionTorrent({
          hash: "seeding-hash",
          name: "Seeding.Torrent",
          state: "seeding",
          status: 6,
          queuePosition: 1,
        }),
      ]),
    );
    renderAdmin("downloads");

    expect(
      await screen.findByRole("button", { name: "Start Stopped.Torrent" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Stop Seeding.Torrent" }),
    ).toBeTruthy();
  });

  it("disables the mutation button in flight and ignores a rapid second click", async () => {
    vi.mocked(useTransmissionEnabled).mockReturnValue(true);
    vi.mocked(fetchTransmission)
      .mockResolvedValueOnce(
        transmissionResponse([
          transmissionTorrent({ state: "stopped", status: 0 }),
        ]),
      )
      .mockResolvedValue(
        transmissionResponse([
          transmissionTorrent({ state: "downloading", status: 4 }),
        ]),
      );
    let resolveStart!: (torrent: TransmissionTorrentView) => void;
    vi.mocked(startTransmissionTorrent).mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    renderAdmin("downloads");

    const start = await screen.findByRole("button", {
      name: "Start Example.Show.S01E01",
    });
    fireEvent.click(start);
    fireEvent.click(start);

    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(startTransmissionTorrent).toHaveBeenCalledTimes(1);
    resolveStart(
      transmissionTorrent({ state: "downloading", status: 4 }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop Example.Show.S01E01" }),
      ).toBeTruthy(),
    );
    expect(startTransmissionTorrent).toHaveBeenCalledTimes(1);
  });

  it("does not expand torrent detail when the mutation button is clicked", async () => {
    vi.mocked(useTransmissionEnabled).mockReturnValue(true);
    vi.mocked(fetchTransmission).mockResolvedValue(
      transmissionResponse([
        transmissionTorrent({ state: "stopped", status: 0 }),
      ]),
    );
    renderAdmin("downloads");

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Start Example.Show.S01E01",
      }),
    );

    expect(fetchTransmissionDetail).not.toHaveBeenCalled();
    expect(screen.queryByText("Loading torrent detail…")).toBeNull();
  });

  it("surfaces a mutation failure without changing the row", async () => {
    vi.mocked(useTransmissionEnabled).mockReturnValue(true);
    vi.mocked(fetchTransmission).mockResolvedValue(
      transmissionResponse([
        transmissionTorrent({ state: "stopped", status: 0 }),
      ]),
    );
    vi.mocked(startTransmissionTorrent).mockRejectedValue(
      new Error("Transmission start command was accepted but the state did not change"),
    );
    renderAdmin("downloads");

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Start Example.Show.S01E01",
      }),
    );

    expect(
      await screen.findByText(
        "Transmission start command was accepted but the state did not change",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Start Example.Show.S01E01" }),
    ).toBeTruthy();
  });
});

describe("AdminPage blocklist tab", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.mocked(fetchBlocklist).mockReset();
    vi.mocked(addToBlocklist).mockReset();
    vi.mocked(removeFromBlocklist).mockReset();
    vi.mocked(fetchBlocklist).mockResolvedValue(blocklistPage());
    vi.mocked(fetchBadgeCounts).mockReset();
    vi.mocked(fetchBadgeCounts).mockResolvedValue(ZERO_BADGE_COUNTS);
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

describe("AdminPage tab badge dots", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.mocked(fetchBlocklist).mockReset();
    vi.mocked(fetchBlocklist).mockResolvedValue(blocklistPage());
    vi.mocked(fetchBadgeCounts).mockReset();
  });

  it("dots Requests, Issues, and Access when their admin counts are above zero", async () => {
    // Distinct non-zero values so wiring the wrong field to a tab fails.
    vi.mocked(fetchBadgeCounts).mockResolvedValue({
      mine: { requests: 0, issues: 0 },
      admin: { requests: 4, issues: 7, access: 2 },
    });

    renderAdmin("blocklist");

    const requests = await screen.findByRole("tab", {
      name: "Requests, 4 pending",
    });
    expect(requests.querySelector(".admin-tab-badge")).not.toBeNull();

    const issues = screen.getByRole("tab", { name: "Issues, 7 open" });
    expect(issues.querySelector(".admin-tab-badge")).not.toBeNull();

    const access = screen.getByRole("tab", { name: "Access, 2 pending" });
    expect(access.querySelector(".admin-tab-badge")).not.toBeNull();
  });

  it("omits the dot on a zero-count tab while keeping dots on non-zero ones", async () => {
    vi.mocked(fetchBadgeCounts).mockResolvedValue({
      mine: { requests: 0, issues: 0 },
      admin: { requests: 3, issues: 0, access: 1 },
    });

    renderAdmin("blocklist");

    const requests = await screen.findByRole("tab", {
      name: "Requests, 3 pending",
    });
    expect(requests.querySelector(".admin-tab-badge")).not.toBeNull();

    const issues = screen.getByRole("tab", { name: "Issues" });
    expect(issues.querySelector(".admin-tab-badge")).toBeNull();

    const access = screen.getByRole("tab", { name: "Access, 1 pending" });
    expect(access.querySelector(".admin-tab-badge")).not.toBeNull();
  });

  it("never dots Blocklist, Users, System, Jobs, or Containers", async () => {
    vi.mocked(fetchBadgeCounts).mockResolvedValue({
      mine: { requests: 9, issues: 9 },
      admin: { requests: 9, issues: 9, access: 9 },
    });

    renderAdmin("blocklist");

    await screen.findByRole("tab", { name: "Requests, 9 pending" });

    for (const label of [
      "Blocklist",
      "Users",
      "System",
      "Jobs",
      "Containers",
    ] as const) {
      const tab = screen.getByRole("tab", { name: label });
      expect(tab.querySelector(".admin-tab-badge")).toBeNull();
    }
  });

  it("renders no dots and no error text when fetchBadgeCounts rejects", async () => {
    vi.mocked(fetchBadgeCounts).mockRejectedValue(new Error("upstream down"));

    renderAdmin("blocklist");

    const blocklist = await screen.findByRole("tab", { name: "Blocklist" });
    expect(blocklist.getAttribute("aria-selected")).toBe("true");

    for (const label of [
      "Requests",
      "Issues",
      "Access",
      "Blocklist",
      "Users",
      "System",
      "Jobs",
      "Containers",
    ] as const) {
      const tab = screen.getByRole("tab", { name: label });
      expect(tab.querySelector(".admin-tab-badge")).toBeNull();
    }

    const tablist = screen.getByRole("tablist", { name: "Admin sections" });
    expect(within(tablist).queryByText(/upstream down/i)).toBeNull();
    expect(within(tablist).queryByText(/error/i)).toBeNull();
  });

  it("puts the count into the tab's accessible name, not on the decorative dot", async () => {
    vi.mocked(fetchBadgeCounts).mockResolvedValue({
      mine: { requests: 0, issues: 0 },
      admin: { requests: 4, issues: 0, access: 0 },
    });

    renderAdmin("blocklist");

    const tab = await screen.findByRole("tab", {
      name: "Requests, 4 pending",
    });
    const dot = tab.querySelector(".admin-tab-badge");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.textContent).toBe("");
  });
});

const pendingRequest: RequestView = {
  id: 99,
  tmdbId: 603,
  mediaType: "movie",
  title: "The Matrix",
  posterUrl: null,
  seasons: [],
  requestStatus: "pending",
  mediaStatus: "unknown",
  requestedById: 7,
  requestedByName: "Alice",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const pendingAccess: AccessRequestView = {
  id: "acc-1",
  email: "alice@example.com",
  plexUsername: null,
  name: "Alice",
  note: "Please",
  hasPlexAccount: false,
  status: "pending",
  createdAt: 1_700_000_000,
  decidedAt: null,
  invitedAt: null,
  acceptedAt: null,
  sectionIds: null,
  adminNote: null,
  sourceIp: null,
};

describe("AdminPage badge refresh after actions", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.mocked(fetchBlocklist).mockReset();
    vi.mocked(fetchBlocklist).mockResolvedValue(blocklistPage());
    vi.mocked(fetchBadgeCounts).mockReset();
    vi.mocked(fetchAllRequests).mockReset();
    vi.mocked(approveRequest).mockReset();
    vi.mocked(fetchAccessRequests).mockReset();
    vi.mocked(fetchAccessRequestSections).mockReset();
    vi.mocked(approveAccessRequest).mockReset();
  });

  it("refetches badge counts after a successful request approve", async () => {
    vi.mocked(fetchBadgeCounts).mockResolvedValue({
      mine: { requests: 0, issues: 0 },
      admin: { requests: 1, issues: 0, access: 0 },
    });
    vi.mocked(fetchAllRequests).mockResolvedValue([pendingRequest]);
    vi.mocked(approveRequest).mockResolvedValue({
      ...pendingRequest,
      requestStatus: "approved",
    });

    renderAdmin("requests");
    await screen.findByRole("tab", { name: "Requests, 1 pending" });
    expect(fetchBadgeCounts).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(fetchBadgeCounts).toHaveBeenCalledTimes(2);
    });
  });

  it("refetches badge counts after a successful access approve", async () => {
    vi.mocked(fetchBadgeCounts).mockResolvedValue({
      mine: { requests: 0, issues: 0 },
      admin: { requests: 0, issues: 0, access: 1 },
    });
    vi.mocked(fetchAccessRequests).mockResolvedValue({
      requests: [pendingAccess],
      reconciledAt: Math.floor(Date.now() / 1000),
    });
    vi.mocked(fetchAccessRequestSections).mockResolvedValue([
      { id: 1, key: 1, title: "Movies", type: "movie" },
    ]);
    vi.mocked(approveAccessRequest).mockResolvedValue({
      ...pendingAccess,
      status: "invited",
      decidedAt: 1_700_000_100,
      invitedAt: 1_700_000_100,
      sectionIds: [1],
    });

    renderAdmin("access");
    await screen.findByRole("tab", { name: "Access, 1 pending" });
    expect(fetchBadgeCounts).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Send invite?" }));

    await waitFor(() => {
      expect(fetchBadgeCounts).toHaveBeenCalledTimes(2);
    });
  });

  it("does not refetch badge counts when a request action fails", async () => {
    vi.mocked(fetchBadgeCounts).mockResolvedValue({
      mine: { requests: 0, issues: 0 },
      admin: { requests: 1, issues: 0, access: 0 },
    });
    vi.mocked(fetchAllRequests).mockResolvedValue([pendingRequest]);
    vi.mocked(approveRequest).mockRejectedValue(new Error("approve failed"));

    renderAdmin("requests");
    await screen.findByRole("tab", { name: "Requests, 1 pending" });
    expect(fetchBadgeCounts).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("approve failed")).toBeTruthy();

    // Give any accidental success-path refresh a turn to fire.
    await waitFor(() => {
      expect(approveRequest).toHaveBeenCalled();
    });
    expect(fetchBadgeCounts).toHaveBeenCalledTimes(1);
  });

  it("clears the Requests dot when the follow-up badge fetch returns zero", async () => {
    let badgeCalls = 0;
    vi.mocked(fetchBadgeCounts).mockImplementation(async () => {
      badgeCalls += 1;
      return {
        mine: { requests: 0, issues: 0 },
        admin: {
          requests: badgeCalls === 1 ? 1 : 0,
          issues: 0,
          access: 0,
        },
      };
    });
    vi.mocked(fetchAllRequests).mockResolvedValue([pendingRequest]);
    vi.mocked(approveRequest).mockResolvedValue({
      ...pendingRequest,
      requestStatus: "approved",
    });

    renderAdmin("requests");
    const badged = await screen.findByRole("tab", {
      name: "Requests, 1 pending",
    });
    expect(badged.querySelector(".admin-tab-badge")).not.toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => {
      const tab = screen.getByRole("tab", { name: "Requests" });
      expect(tab.querySelector(".admin-tab-badge")).toBeNull();
    });
  });
});
