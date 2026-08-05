// Back-link destination for IssueDetailPage: Admin → Issues vs My Issues vs a
// direct load with no router state. Auth is the real AuthProvider with fetchMe
// mocked at api/auth — same boundary as MediaDetailPage.test.tsx.
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMe } from "../api/auth";
import { fetchIssue, type IssueView } from "../api/issues";
import { AuthProvider } from "../auth/AuthContext";
import { IssueDetailPage } from "./IssueDetailPage";

vi.mock("../api/auth", () => ({
  fetchMe: vi.fn(),
  logoutRequest: vi.fn(),
}));

vi.mock("../api/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/issues")>();
  return {
    ...actual,
    fetchIssue: vi.fn(),
    addIssueComment: vi.fn(),
    setIssueStatus: vi.fn(),
  };
});

const sampleIssue: IssueView = {
  id: 12,
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

function meUser(isAdmin: boolean) {
  return {
    isAdmin,
    user: {
      seerrUserId: 1,
      plexId: 1,
      plexUsername: "testuser",
      displayName: "Test User",
      avatar: null,
      permissions: isAdmin ? 2 : 0,
    },
  };
}

function renderDetail(options: {
  isAdmin: boolean;
  state?: { from?: unknown };
}) {
  return render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/issues/12",
          ...(options.state === undefined ? {} : { state: options.state }),
        },
      ]}
    >
      <AuthProvider>
        <Routes>
          <Route path="/issues/:id" element={<IssueDetailPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("IssueDetailPage back link", () => {
  beforeEach(() => {
    vi.mocked(fetchMe).mockReset();
    vi.mocked(fetchIssue).mockReset();
    vi.mocked(fetchIssue).mockResolvedValue(sampleIssue);
  });

  afterEach(() => {
    cleanup();
  });

  it("returns to Admin Issues when state.from is the admin issues tab", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(true));
    renderDetail({
      isAdmin: true,
      state: { from: "/admin?tab=issues" },
    });

    const back = await screen.findByRole("link", {
      name: "← Back to Issues",
    });
    expect(back.getAttribute("href")).toBe("/admin?tab=issues");
  });

  it("returns to My Issues when state.from is /issues", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    renderDetail({
      isAdmin: false,
      state: { from: "/issues" },
    });

    const back = await screen.findByRole("link", {
      name: "← Back to My Issues",
    });
    expect(back.getAttribute("href")).toBe("/issues");
  });

  it("falls back to My Issues when there is no router state", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    renderDetail({ isAdmin: false });

    const back = await screen.findByRole("link", {
      name: "← Back to My Issues",
    });
    expect(back.getAttribute("href")).toBe("/issues");
  });

  it("falls back to My Issues when state.from is unrecognised", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    renderDetail({
      isAdmin: false,
      state: { from: "/media/tv/1396" },
    });

    const back = await screen.findByRole("link", {
      name: "← Back to My Issues",
    });
    expect(back.getAttribute("href")).toBe("/issues");
  });

  it("points the admin link at /admin?tab=issues for an admin", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(true));
    renderDetail({ isAdmin: true });

    const admin = await screen.findByRole("link", { name: "Admin" });
    expect(admin.getAttribute("href")).toBe("/admin?tab=issues");
  });

  it("hides the admin link for a non-admin", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meUser(false));
    renderDetail({ isAdmin: false });

    await screen.findByRole("link", { name: "← Back to My Issues" });
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
  });
});
