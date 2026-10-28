// Route-table tests for Seerr's /movie/:tmdbId and /tv/:tmdbId links. Renders
// the real App inside MemoryRouter and AuthProvider. AppShell is an Outlet,
// and LoginPage, LibraryPage and MediaDetailPage are location probes, so a
// test can read where a visit ended without mounting those pages.
//
// The probe text is "<page> <pathname><search><hash> <JSON state> <nav>".
// search, hash and the navigation type are on the same node so a dropped
// query and a replace are visible, not only the pathname.
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMe } from "./api/auth";
import { AuthProvider } from "./auth/AuthContext";
import { App } from "./App";

vi.mock("./api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/auth")>();
  return {
    ...actual,
    fetchMe: vi.fn(),
    logoutRequest: vi.fn(),
  };
});

vi.mock("./components/AppShell", async () => {
  const { Outlet } = await import("react-router");
  return {
    AppShell() {
      return <Outlet />;
    },
  };
});

vi.mock("./pages/LoginPage", async () => {
  const { useLocation, useNavigationType } = await import("react-router");
  return {
    LoginPage() {
      const location = useLocation();
      const navigationType = useNavigationType();
      return (
        <pre data-testid="location">
          {`login ${location.pathname}${location.search}${location.hash} ${JSON.stringify(location.state)} ${navigationType}`}
        </pre>
      );
    },
  };
});

vi.mock("./pages/LibraryPage", async () => {
  const { useLocation, useNavigationType } = await import("react-router");
  return {
    LibraryPage() {
      const location = useLocation();
      const navigationType = useNavigationType();
      return (
        <pre data-testid="location">
          {`library ${location.pathname}${location.search}${location.hash} ${JSON.stringify(location.state)} ${navigationType}`}
        </pre>
      );
    },
  };
});

vi.mock("./pages/MediaDetailPage", async () => {
  const { useLocation, useNavigationType } = await import("react-router");
  return {
    MediaDetailPage() {
      const location = useLocation();
      const navigationType = useNavigationType();
      return (
        <pre data-testid="location">
          {`media ${location.pathname}${location.search}${location.hash} ${JSON.stringify(location.state)} ${navigationType}`}
        </pre>
      );
    },
  };
});

const me = {
  isAdmin: false,
  user: {
    seerrUserId: 1,
    plexId: 1,
    plexUsername: "testuser",
    displayName: "Test User",
    avatar: null,
    permissions: 0,
  },
  preferences: { fullscreenOnPlay: true },
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("Seerr title links", () => {
  beforeEach(() => {
    vi.mocked(fetchMe).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("sends a signed-in /tv/1396 to /media/tv/1396", async () => {
    vi.mocked(fetchMe).mockResolvedValue(me);
    renderAt("/tv/1396");
    expect((await screen.findByTestId("location")).textContent).toBe(
      'media /media/tv/1396 {"landing":true} REPLACE',
    );
  });

  it("sends a signed-in /movie/550 to /media/movie/550", async () => {
    vi.mocked(fetchMe).mockResolvedValue(me);
    renderAt("/movie/550");
    expect((await screen.findByTestId("location")).textContent).toBe(
      'media /media/movie/550 {"landing":true} REPLACE',
    );
  });

  it("sends a signed-out /tv/1396 to /login", async () => {
    vi.mocked(fetchMe).mockResolvedValue(null);
    renderAt("/tv/1396");
    expect((await screen.findByTestId("location")).textContent).toBe(
      'login /login {"returnTo":"/media/tv/1396"} REPLACE',
    );
  });

  it("drops the query string and hash", async () => {
    vi.mocked(fetchMe).mockResolvedValue(me);
    renderAt("/tv/1396?utm_source=x#top");
    expect((await screen.findByTestId("location")).textContent).toBe(
      'media /media/tv/1396 {"landing":true} REPLACE',
    );
  });

  it("forwards a non-numeric id to the title page", async () => {
    vi.mocked(fetchMe).mockResolvedValue(me);
    renderAt("/tv/abc");
    expect((await screen.findByTestId("location")).textContent).toBe(
      'media /media/tv/abc {"landing":true} REPLACE',
    );
  });

  // react-router decodes %2F in the param. The redirect has to encode it
  // again, or /media/tv/../admin collapses and the catch-all sends it to
  // Library.
  it("encodes a decoded slash in /tv/..%2Fadmin", async () => {
    vi.mocked(fetchMe).mockResolvedValue(me);
    renderAt("/tv/..%2Fadmin");
    expect((await screen.findByTestId("location")).textContent).toBe(
      'media /media/tv/..%2Fadmin {"landing":true} REPLACE',
    );
  });
});
