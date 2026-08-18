// URL-level coverage for me API helpers. globalThis.fetch is stubbed so we can
// assert the request the helper builds, same pattern as admin.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { updatePreferences } from "./me";

describe("updatePreferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes /api/me/preferences and resolves with the server body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ fullscreenOnPlay: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await updatePreferences({ fullscreenOnPlay: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/me/preferences");
    expect(init).toMatchObject({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullscreenOnPlay: false }),
    });
    expect(result).toEqual({ fullscreenOnPlay: false });
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "failed to save preferences" }),
      }),
    );

    await expect(
      updatePreferences({ fullscreenOnPlay: false }),
    ).rejects.toThrow(/500/);
  });
});
