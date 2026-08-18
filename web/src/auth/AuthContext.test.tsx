// AuthProvider preferences: default before /me answers, reset on logout, and
// setPreferences replacing the held value without a second fetchMe.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMe, logoutRequest, type MeResponse } from "../api/auth";
import { AuthProvider, useAuth } from "./AuthContext";

vi.mock("../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/auth")>();
  return {
    ...actual,
    fetchMe: vi.fn(),
    logoutRequest: vi.fn(),
  };
});

function Probe() {
  const { preferences, status, setPreferences, logout } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="fullscreen">
        {String(preferences.fullscreenOnPlay)}
      </span>
      <button
        type="button"
        onClick={() => setPreferences({ fullscreenOnPlay: false })}
      >
        set-false
      </button>
      <button type="button" onClick={() => void logout()}>
        logout
      </button>
    </div>
  );
}

function meResponse(
  preferences: MeResponse["preferences"] = { fullscreenOnPlay: true },
): MeResponse {
  return {
    isAdmin: false,
    user: {
      seerrUserId: 1,
      plexId: 1,
      plexUsername: "testuser",
      displayName: "Test User",
      avatar: null,
      permissions: 0,
    },
    preferences,
  };
}

describe("AuthProvider preferences", () => {
  beforeEach(() => {
    vi.mocked(fetchMe).mockReset();
    vi.mocked(logoutRequest).mockReset();
    vi.mocked(logoutRequest).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults fullscreenOnPlay to true before /me answers and after logout", async () => {
    let resolveMe!: (value: MeResponse | null) => void;
    vi.mocked(fetchMe).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMe = resolve;
        }),
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByTestId("status").textContent).toBe("loading");
    expect(screen.getByTestId("fullscreen").textContent).toBe("true");

    await act(async () => {
      resolveMe(meResponse({ fullscreenOnPlay: false }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("authed");
    });
    expect(screen.getByTestId("fullscreen").textContent).toBe("false");

    await act(async () => {
      screen.getByRole("button", { name: "logout" }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("anon");
    });
    expect(screen.getByTestId("fullscreen").textContent).toBe("true");
  });

  it("setPreferences replaces the held value without calling fetchMe again", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse({ fullscreenOnPlay: true }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("authed");
    });
    expect(vi.mocked(fetchMe)).toHaveBeenCalledTimes(1);

    await act(async () => {
      screen.getByRole("button", { name: "set-false" }).click();
    });

    expect(screen.getByTestId("fullscreen").textContent).toBe("false");
    expect(vi.mocked(fetchMe)).toHaveBeenCalledTimes(1);
  });
});
