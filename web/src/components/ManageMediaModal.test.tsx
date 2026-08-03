// ManageMediaModal: admin remove flow for a title page. Covers Escape-to-close,
// the two-click arm/confirm, the blocklist query flag, the partial-failure
// 500 body, and the TV season/episode tree.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchSeasonTree,
  removeEpisode,
  removeMedia,
  removeSeason,
  type AdminSeasonTree,
} from "../api/admin";
import { fetchAllRequests, type RequestView } from "../api/requests";
import { ManageMediaModal } from "./ManageMediaModal";

vi.mock("../api/admin", () => ({
  removeMedia: vi.fn(),
  fetchSeasonTree: vi.fn(),
  removeSeason: vi.fn(),
  removeEpisode: vi.fn(),
}));

vi.mock("../api/requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/requests")>();
  return {
    ...actual,
    fetchAllRequests: vi.fn(),
  };
});

function requestView(
  overrides: Partial<RequestView> = {},
): RequestView {
  return {
    id: 10,
    tmdbId: 603,
    mediaType: "movie",
    title: "The Matrix",
    posterUrl: null,
    seasons: [],
    requestStatus: "approved",
    mediaStatus: "available",
    requestedById: 7,
    requestedByName: "Alice",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T01:00:00.000Z",
    ...overrides,
  };
}

function seasonTree(
  overrides: Partial<AdminSeasonTree> = {},
): AdminSeasonTree {
  return {
    tmdbId: 1396,
    sonarrSeriesId: 97,
    seasons: [
      {
        seasonNumber: 0,
        monitored: false,
        episodeCount: 1,
        episodeFileCount: 1,
        sizeOnDisk: 50,
        episodes: [
          {
            id: 100,
            episodeNumber: 1,
            title: "Special",
            monitored: false,
            hasFile: true,
            episodeFileId: 500,
            size: 50,
          },
        ],
      },
      {
        seasonNumber: 1,
        monitored: true,
        episodeCount: 2,
        episodeFileCount: 1,
        sizeOnDisk: 100,
        episodes: [
          {
            id: 101,
            episodeNumber: 1,
            title: "Pilot",
            monitored: true,
            hasFile: true,
            episodeFileId: 501,
            size: 100,
          },
          {
            id: 102,
            episodeNumber: 2,
            title: "Missing File",
            monitored: true,
            hasFile: false,
            episodeFileId: 0,
            size: 0,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function Harness({
  mediaType = "movie" as const,
  tmdbId = 603,
  title = "The Matrix",
}: {
  mediaType?: "movie" | "tv";
  tmdbId?: number;
  title?: string;
}) {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button">
        Open manage
      </button>
      <ManageMediaModal
        open={open}
        onClose={() => setOpen(false)}
        returnFocusRef={triggerRef}
        mediaType={mediaType}
        tmdbId={tmdbId}
        title={title}
      />
    </>
  );
}

describe("ManageMediaModal", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(removeMedia).mockReset();
    vi.mocked(fetchAllRequests).mockReset();
    vi.mocked(fetchSeasonTree).mockReset();
    vi.mocked(removeSeason).mockReset();
    vi.mocked(removeEpisode).mockReset();
  });

  it("closes on Escape", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);

    render(<Harness />);
    expect(await screen.findByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("arms on the first remove click and confirms on the second", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);
    vi.mocked(removeMedia).mockResolvedValue({
      status: 200,
      tmdbId: 603,
      mediaType: "movie",
      filesDeleted: true,
      blocklisted: true,
      mediaRowDeleted: null,
      requestsDeclined: [10],
      requestsFailedToDecline: [],
    });

    render(<Harness />);
    const dialog = await screen.findByRole("dialog");
    const remove = within(dialog).getByRole("button", {
      name: "Remove from Radarr",
    });

    fireEvent.click(remove);
    expect(removeMedia).not.toHaveBeenCalled();
    expect(
      within(dialog).getByRole("button", { name: /confirm remove/i }),
    ).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", { name: /confirm remove/i }),
    );
    await waitFor(() => {
      expect(removeMedia).toHaveBeenCalledTimes(1);
    });
    expect(removeMedia).toHaveBeenCalledWith("movie", 603, {
      blocklist: true,
    });
  });

  it("calls no API when the remove action is not armed", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);

    render(<Harness />);
    await screen.findByRole("dialog");
    expect(removeMedia).not.toHaveBeenCalled();
  });

  it("checks the prevent-re-request checkbox by default when the modal opens", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);

    render(<Harness />);
    const dialog = await screen.findByRole("dialog");
    const checkbox = within(dialog).getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("sends blocklist true when confirming remove without touching the checkbox", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);
    vi.mocked(removeMedia).mockResolvedValue({
      status: 200,
      tmdbId: 603,
      mediaType: "movie",
      filesDeleted: true,
      blocklisted: true,
      mediaRowDeleted: null,
      requestsDeclined: [],
      requestsFailedToDecline: [],
    });

    render(<Harness />);
    const dialog = await screen.findByRole("dialog");
    const checkbox = within(dialog).getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove from Radarr" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: /confirm remove/i }),
    );

    await waitFor(() => {
      expect(removeMedia).toHaveBeenCalledWith("movie", 603, {
        blocklist: true,
      });
    });
  });

  it("sends blocklist false when the prevent-re-request checkbox is unchecked", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);
    vi.mocked(removeMedia).mockResolvedValue({
      status: 200,
      tmdbId: 603,
      mediaType: "movie",
      filesDeleted: true,
      blocklisted: null,
      mediaRowDeleted: true,
      requestsDeclined: [],
      requestsFailedToDecline: [],
    });

    render(<Harness />);
    const dialog = await screen.findByRole("dialog");
    const checkbox = within(dialog).getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove from Radarr" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: /confirm remove/i }),
    );

    await waitFor(() => {
      expect(removeMedia).toHaveBeenCalledWith("movie", 603, {
        blocklist: false,
      });
    });
  });

  it("renders a partial-failure warning when files deleted but blocklist failed", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);
    vi.mocked(removeMedia).mockResolvedValue({
      status: 500,
      tmdbId: 603,
      mediaType: "movie",
      filesDeleted: true,
      blocklisted: false,
      mediaRowDeleted: null,
      requestsDeclined: [],
      requestsFailedToDecline: [],
      error: "Seerr boom",
    });

    render(<Harness />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove from Radarr" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: /confirm remove/i }),
    );

    expect(
      await within(dialog).findByText(
        /files are gone, but the blocklist did not apply/i,
      ),
    ).toBeTruthy();
  });

  it("lists filtered requests for the title and shows No requests when empty", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([
      requestView({
        id: 10,
        tmdbId: 603,
        mediaType: "movie",
        requestedByName: "Alice",
        requestStatus: "approved",
      }),
      requestView({
        id: 11,
        tmdbId: 603,
        mediaType: "tv",
        requestedByName: "Bob",
        requestStatus: "pending",
        seasons: [1, 2],
      }),
      requestView({
        id: 12,
        tmdbId: 1396,
        mediaType: "movie",
        requestedByName: "Carol",
      }),
    ]);

    render(<Harness />);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Alice")).toBeTruthy();
    expect(within(dialog).getByText(/approved/i)).toBeTruthy();
    expect(within(dialog).queryByText("Bob")).toBeNull();
    expect(within(dialog).queryByText("Carol")).toBeNull();
  });

  it("labels the destructive action Remove from Sonarr for TV", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([
      requestView({
        id: 20,
        tmdbId: 1396,
        mediaType: "tv",
        requestedByName: "Dana",
        requestStatus: "pending",
        seasons: [1, 3],
      }),
    ]);
    vi.mocked(fetchSeasonTree).mockResolvedValue(seasonTree());

    render(<Harness mediaType="tv" tmdbId={1396} title="Breaking Bad" />);
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByRole("button", {
        name: "Remove from Sonarr",
      }),
    ).toBeTruthy();
    expect(within(dialog).getByText("Dana")).toBeTruthy();
    expect(within(dialog).getByText("Seasons 1, 3")).toBeTruthy();
  });

  it("does not render the season tree for a movie", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);

    render(<Harness />);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Media")).toBeTruthy();
    expect(fetchSeasonTree).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole("heading", { name: "Seasons" })).toBeNull();
    expect(within(dialog).queryByText("Specials")).toBeNull();
  });

  it("keeps seasons collapsed until expanded", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);
    vi.mocked(fetchSeasonTree).mockResolvedValue(seasonTree());

    render(<Harness mediaType="tv" tmdbId={1396} title="Breaking Bad" />);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Specials")).toBeTruthy();
    expect(within(dialog).getByText(/Season 1/)).toBeTruthy();
    expect(within(dialog).queryByText("Pilot")).toBeNull();
    expect(within(dialog).queryByText("Missing File")).toBeNull();

    fireEvent.click(
      within(dialog).getByRole("button", { name: /^Season 1,/ }),
    );
    expect(await within(dialog).findByText("Pilot")).toBeTruthy();
    expect(within(dialog).getByText("Missing File")).toBeTruthy();
  });

  it("includes file count, size, and monitored state in the season toggle name", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);
    vi.mocked(fetchSeasonTree).mockResolvedValue(seasonTree());

    render(<Harness mediaType="tv" tmdbId={1396} title="Breaking Bad" />);
    const dialog = await screen.findByRole("dialog");
    const toggle = await within(dialog).findByRole("button", {
      name: /^Season 1,/,
    });
    expect(toggle.getAttribute("aria-label")).toMatch(/1 of 2 files/);
    expect(toggle.getAttribute("aria-label")).toMatch(/100 B/);
    expect(toggle.getAttribute("aria-label")).toMatch(/monitored/);
  });

  it("disables remove for an episode that has no file", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);
    vi.mocked(fetchSeasonTree).mockResolvedValue(seasonTree());

    render(<Harness mediaType="tv" tmdbId={1396} title="Breaking Bad" />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: /^Season 1,/ }),
    );

    const missing = await within(dialog).findByText("Missing File");
    const row = missing.closest("li");
    expect(row).toBeTruthy();
    const remove = within(row as HTMLElement).getByRole("button", {
      name: /remove/i,
    });
    expect(remove).toHaveProperty("disabled", true);
  });

  it("disarms the first control when a second control is armed", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);
    vi.mocked(fetchSeasonTree).mockResolvedValue(seasonTree());

    render(<Harness mediaType="tv" tmdbId={1396} title="Breaking Bad" />);
    const dialog = await screen.findByRole("dialog");
    const titleRemove = await within(dialog).findByRole("button", {
      name: "Remove from Sonarr",
    });
    fireEvent.click(titleRemove);
    expect(
      within(dialog).getByRole("button", { name: /confirm remove/i }),
    ).toBeTruthy();

    const seasonRemove = within(dialog).getByRole("button", {
      name: /remove season 1/i,
    });
    fireEvent.click(seasonRemove);

    expect(
      within(dialog).queryByRole("button", { name: "Confirm remove?" }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", {
        name: /confirm remove season 1/i,
      }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Remove from Sonarr" }),
    ).toBeTruthy();
  });

  it("calls removeSeason with the season number and refetches the tree", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);
    vi.mocked(fetchSeasonTree)
      .mockResolvedValueOnce(seasonTree())
      .mockResolvedValueOnce(
        seasonTree({
          seasons: [
            {
              seasonNumber: 0,
              monitored: false,
              episodeCount: 1,
              episodeFileCount: 1,
              sizeOnDisk: 50,
              episodes: [
                {
                  id: 100,
                  episodeNumber: 1,
                  title: "Special",
                  monitored: false,
                  hasFile: true,
                  episodeFileId: 500,
                  size: 50,
                },
              ],
            },
          ],
        }),
      );
    vi.mocked(removeSeason).mockResolvedValue({
      status: 200,
      tmdbId: 1396,
      seasonNumber: 1,
      unmonitored: true,
      filesDeleted: [501],
      filesFailedToDelete: [],
      requestsDeclined: [],
      requestsLeftOpen: [],
    });

    render(<Harness mediaType="tv" tmdbId={1396} title="Breaking Bad" />);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Season 1/)).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", { name: /remove season 1/i }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: /confirm remove season 1/i,
      }),
    );

    await waitFor(() => {
      expect(removeSeason).toHaveBeenCalledWith(1396, 1);
    });
    await waitFor(() => {
      expect(fetchSeasonTree).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        within(dialog).queryByRole("button", { name: /^Season 1,/ }),
      ).toBeNull();
    });
  });

  it("renders a season partial-failure 500 as a failure with per-file detail", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);
    vi.mocked(fetchSeasonTree)
      .mockResolvedValueOnce(seasonTree())
      .mockResolvedValueOnce(
        seasonTree({
          seasons: [
            {
              seasonNumber: 1,
              monitored: false,
              episodeCount: 2,
              episodeFileCount: 0,
              sizeOnDisk: 0,
              episodes: [],
            },
          ],
        }),
      );
    vi.mocked(removeSeason).mockResolvedValue({
      status: 500,
      tmdbId: 1396,
      seasonNumber: 1,
      unmonitored: true,
      filesDeleted: [501],
      filesFailedToDelete: [{ fileId: 502, error: "stale file" }],
      requestsDeclined: [],
      requestsLeftOpen: [],
    });

    render(<Harness mediaType="tv" tmdbId={1396} title="Breaking Bad" />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: /remove season 1/i,
      }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: /confirm remove season 1/i,
      }),
    );

    expect(
      await within(dialog).findByText(/partial failure|failed to delete/i),
    ).toBeTruthy();
    expect(within(dialog).getByText(/502/)).toBeTruthy();

    // A partial delete leaves the on-screen counts stale, so the tree refetches
    // on the 500 path too and the UI shows the refreshed counts.
    await waitFor(() => {
      expect(fetchSeasonTree).toHaveBeenCalledTimes(2);
    });
    expect(
      await within(dialog).findByRole("button", {
        name: /^Season 1, 0 of 2 files/,
      }),
    ).toBeTruthy();

    // The per-file failure summary lives in granularResult, which the tree
    // effect does not touch, so it must survive the refetch.
    expect(
      within(dialog).getByText(/partial failure|failed to delete/i),
    ).toBeTruthy();
    expect(within(dialog).getByText(/502/)).toBeTruthy();
  });

  it("explains requestsLeftOpen after a season removal without treating it as an error", async () => {
    vi.mocked(fetchAllRequests).mockResolvedValue([]);
    vi.mocked(fetchSeasonTree).mockResolvedValue(seasonTree());
    vi.mocked(removeSeason).mockResolvedValue({
      status: 200,
      tmdbId: 1396,
      seasonNumber: 1,
      unmonitored: true,
      filesDeleted: [501],
      filesFailedToDelete: [],
      requestsDeclined: [],
      requestsLeftOpen: [{ id: 11, seasons: [1, 2, 3, 4] }],
    });

    render(<Harness mediaType="tv" tmdbId={1396} title="Breaking Bad" />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: /remove season 1/i,
      }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: /confirm remove season 1/i,
      }),
    );

    const note = await within(dialog).findByText(/not declined/i);
    expect(note.className).not.toMatch(/error/);
    expect(note.textContent).toMatch(/1,\s*2,\s*3,\s*4/);
    expect(note.textContent).toMatch(/whole request|entire request/i);
  });
});
