// Anon redirects from ProtectedRoute and AdminRoute. Renders the real guards
// inside MemoryRouter and AuthProvider, with fetchMe mocked, and a login
// probe that prints the pathname and JSON state. The signed-in page is a
// logout button so the same tab can sign out and come back to /login.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMe, logoutRequest } from "../api/auth";
import { AuthProvider, useAuth } from "./AuthContext";
import { AdminRoute, ProtectedRoute } from "./ProtectedRoute";

vi.mock("../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/auth")>();
  return {
    ...actual,
    fetchMe: vi.fn(),
    logoutRequest: vi.fn(),
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

function LoginProbe() {
  const location = useLocation();
  return (
    <pre data-testid="location">
      {`${location.pathname}${location.search}${location.hash} ${JSON.stringify(location.state)}`}
    </pre>
  );
}

function SignedInPage() {
  const { logout } = useAuth();
  return (
    <button type="button" onClick={() => void logout()}>
      Log out
    </button>
  );
}

describe("anon redirect returnTo", () => {
  beforeEach(() => {
    vi.mocked(fetchMe).mockReset();
    vi.mocked(logoutRequest).mockReset();
    vi.mocked(logoutRequest).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("sends a signed-out /media visit to /login with returnTo", async () => {
    vi.mocked(fetchMe).mockResolvedValue(null);
    render(
      <MemoryRouter initialEntries={["/media/tv/1396?x=1#h"]}>
        <AuthProvider>
          <Routes>
            <Route element={<ProtectedRoute />}>
              <Route path="/media/tv/:id" element={<SignedInPage />} />
            </Route>
            <Route path="/login" element={<LoginProbe />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect((await screen.findByTestId("location")).textContent).toBe(
      '/login {"returnTo":"/media/tv/1396?x=1#h"}',
    );
  });

  it("omits returnTo after logout() in the same tab", async () => {
    vi.mocked(fetchMe).mockResolvedValue(me);
    render(
      <MemoryRouter initialEntries={["/media/tv/1396?x=1#h"]}>
        <AuthProvider>
          <Routes>
            <Route element={<ProtectedRoute />}>
              <Route path="/media/tv/:id" element={<SignedInPage />} />
            </Route>
            <Route path="/login" element={<LoginProbe />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    expect((await screen.findByTestId("location")).textContent).toBe(
      "/login null",
    );
  });

  it("sends a signed-out AdminRoute, rendered on its own, to /login with returnTo", async () => {
    vi.mocked(fetchMe).mockResolvedValue(null);
    render(
      <MemoryRouter initialEntries={["/admin?tab=issues"]}>
        <AuthProvider>
          <Routes>
            <Route element={<AdminRoute />}>
              <Route path="/admin" element={<SignedInPage />} />
            </Route>
            <Route path="/login" element={<LoginProbe />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect((await screen.findByTestId("location")).textContent).toBe(
      '/login {"returnTo":"/admin?tab=issues"}',
    );
  });
});
