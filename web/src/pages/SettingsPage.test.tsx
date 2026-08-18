// Settings page: Playback toggle save-on-change against updatePreferences, and
// fail-loud revert when the PATCH rejects.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMe } from "../api/auth";
import { updatePreferences } from "../api/me";
import { AuthProvider } from "../auth/AuthContext";
import { SettingsPage } from "./SettingsPage";

vi.mock("../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/auth")>();
  return {
    ...actual,
    fetchMe: vi.fn(),
    logoutRequest: vi.fn(),
  };
});

vi.mock("../api/me", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/me")>();
  return {
    ...actual,
    updatePreferences: vi.fn(),
  };
});

function meResponse(fullscreenOnPlay: boolean) {
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
    preferences: { fullscreenOnPlay },
  };
}

function renderSettings() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("SettingsPage Playback toggle", () => {
  beforeEach(() => {
    vi.mocked(fetchMe).mockReset();
    vi.mocked(updatePreferences).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows a checked fullscreen-on-Play toggle when the preference is true", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse(true));
    renderSettings();

    const toggle = (await screen.findByRole("checkbox", {
      name: "Go fullscreen when I press Play",
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    screen.getByRole("heading", { name: "Playback" });
  });

  it("unchecking PATCHes the new value and the toggle follows", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse(true));
    vi.mocked(updatePreferences).mockResolvedValue({
      fullscreenOnPlay: false,
    });
    renderSettings();

    const toggle = (await screen.findByRole("checkbox", {
      name: "Go fullscreen when I press Play",
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => {
      expect(updatePreferences).toHaveBeenCalledWith({
        fullscreenOnPlay: false,
      });
    });
    await waitFor(() => {
      expect(toggle.checked).toBe(false);
    });
  });

  it("reconciles the toggle to the server's reply when it differs from the click", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse(true));
    // Artificial on purpose: reply disagrees with the click so only
    // setPreferences(next) can leave the toggle checked.
    vi.mocked(updatePreferences).mockResolvedValue({
      fullscreenOnPlay: true,
    });
    renderSettings();

    const toggle = (await screen.findByRole("checkbox", {
      name: "Go fullscreen when I press Play",
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => {
      expect(updatePreferences).toHaveBeenCalledWith({
        fullscreenOnPlay: false,
      });
    });
    await waitFor(() => {
      expect(toggle.checked).toBe(true);
    });
  });

  it("reverts the switch and shows an error when updatePreferences rejects", async () => {
    vi.mocked(fetchMe).mockResolvedValue(meResponse(true));
    vi.mocked(updatePreferences).mockRejectedValue(new Error("disk full"));
    renderSettings();

    const toggle = (await screen.findByRole("checkbox", {
      name: "Go fullscreen when I press Play",
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => {
      expect(updatePreferences).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(toggle.checked).toBe(true);
    });
    const alertText = screen.getByRole("alert").textContent ?? "";
    expect(alertText).toMatch(/couldn.?t save/i);
    expect(alertText.includes("disk full")).toBe(false);
  });
});
