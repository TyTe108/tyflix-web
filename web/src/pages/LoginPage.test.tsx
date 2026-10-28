// Where LoginPage sends a signed-in visitor. The early return and the
// navigate() after a finished Plex PIN both go to the resolved return path
// with the landing state. plexOauth and completePlexLogin are mocked; the
// access-request link is not under test.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completePlexLogin, fetchMe } from "../api/auth";
import { AuthProvider } from "../auth/AuthContext";
import { checkPlexPin, createPlexPin } from "../lib/plexOauth";
import { LoginPage } from "./LoginPage";

vi.mock("../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/auth")>();
  return {
    ...actual,
    fetchMe: vi.fn(),
    logoutRequest: vi.fn(),
    completePlexLogin: vi.fn(),
  };
});

vi.mock("../lib/plexOauth", () => ({
  getPlexClientId: vi.fn(() => "client-id"),
  createPlexPin: vi.fn(async () => ({ id: 7, code: "ABCD" })),
  buildPlexAuthUrl: vi.fn(() => "https://app.plex.tv/auth#?code=ABCD"),
  checkPlexPin: vi.fn(async () => ({ authToken: "plex-token" })),
}));

vi.mock("../hooks/useAccessRequestsEnabled", () => ({
  useAccessRequestsEnabled: () => false,
}));

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

function LocationProbe() {
  const location = useLocation();
  return (
    <pre data-testid="location">
      {`${location.pathname}${location.search}${location.hash} ${JSON.stringify(location.state)}`}
    </pre>
  );
}

function renderLogin(
  entry: string | { pathname: string; state?: unknown },
) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("LoginPage return path", () => {
  beforeEach(() => {
    vi.mocked(fetchMe).mockReset();
    vi.mocked(completePlexLogin).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends an already signed-in visit to its returnTo with the landing state", async () => {
    vi.mocked(fetchMe).mockResolvedValue(me);
    renderLogin({
      pathname: "/login",
      state: { returnTo: "/media/tv/1396?x=1#h" },
    });
    expect((await screen.findByTestId("location")).textContent).toBe(
      '/media/tv/1396?x=1#h {"landing":true}',
    );
  });

  it("sends an already signed-in visit with no returnTo to /", async () => {
    vi.mocked(fetchMe).mockResolvedValue(me);
    renderLogin("/login");
    expect((await screen.findByTestId("location")).textContent).toBe(
      '/ {"landing":true}',
    );
  });

  it("sends an already signed-in visit with an unsafe returnTo to /", async () => {
    vi.mocked(fetchMe).mockResolvedValue(me);
    renderLogin({
      pathname: "/login",
      state: { returnTo: "//evil.example" },
    });
    expect((await screen.findByTestId("location")).textContent).toBe(
      '/ {"landing":true}',
    );
  });

  it("finishes a Plex sign-in on the returnTo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(fetchMe).mockResolvedValueOnce(null).mockResolvedValue(me);
    vi.mocked(completePlexLogin).mockResolvedValue({
      kind: "ok",
      data: {
        status: "ok",
        user: me.user,
        isAdmin: false,
      },
    });
    vi.spyOn(window, "open").mockReturnValue({
      closed: false,
      location: { href: "about:blank" },
      close(this: { closed: boolean }) {
        this.closed = true;
      },
    } as unknown as Window);

    renderLogin({
      pathname: "/login",
      state: { returnTo: "/media/tv/1396?x=1#h" },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with Plex" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(createPlexPin)).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);

    expect((await screen.findByTestId("location")).textContent).toBe(
      '/media/tv/1396?x=1#h {"landing":true}',
    );
    expect(vi.mocked(checkPlexPin)).toHaveBeenCalled();
  });
});
