// ManageMediaModal: admin remove flow for a title page. Covers Escape-to-close,
// the two-click arm/confirm, the blocklist query flag, and the partial-failure
// 500 body the API returns when files are gone but the blocklist step failed.
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
import { removeMedia } from "../api/admin";
import { fetchAllRequests, type RequestView } from "../api/requests";
import { ManageMediaModal } from "./ManageMediaModal";

vi.mock("../api/admin", () => ({
  removeMedia: vi.fn(),
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

    render(<Harness mediaType="tv" tmdbId={1396} title="Breaking Bad" />);
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByRole("button", {
        name: "Remove from Sonarr",
      }),
    ).toBeTruthy();
    expect(within(dialog).getByText("Dana")).toBeTruthy();
    expect(within(dialog).getByText(/seasons?\s*1/i)).toBeTruthy();
  });
});
