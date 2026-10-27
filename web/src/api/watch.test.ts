// URL-level coverage for the previous-episode lookup. globalThis.fetch is
// stubbed so we can assert the request the helper builds, same pattern as
// me.test.ts. console.error is a no-op spy so a failure log is counted without
// printing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPreviousEpisode } from "./watch";

const pilotWithoutThumb = {
  ratingKey: "201",
  seasonNumber: 1,
  episodeNumber: 1,
  title: "Pilot",
};

describe("fetchPreviousEpisode", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests /previous once and fills a missing thumb with null", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ previousEpisode: pilotWithoutThumb }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPreviousEpisode("202");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/watch/episode/202/previous");
    expect(result).toEqual({ ...pilotWithoutThumb, thumb: null });
  });

  it("returns null and logs nothing when previousEpisode is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ previousEpisode: null }),
      }),
    );

    await expect(fetchPreviousEpisode("201")).resolves.toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns null and logs once when previousEpisode is missing or malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      }),
    );

    await expect(fetchPreviousEpisode("202")).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);

    vi.mocked(console.error).mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          previousEpisode: {
            ratingKey: "201",
            seasonNumber: "1",
            episodeNumber: 1,
            title: "Pilot",
            thumb: null,
          },
        }),
      }),
    );

    await expect(fetchPreviousEpisode("202")).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("returns null and logs the status when the response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({ error: "upstream" }),
      }),
    );

    await expect(fetchPreviousEpisode("202")).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = vi.mocked(console.error).mock.calls[0]?.join(" ") ?? "";
    expect(logged).toContain("502");
  });

  it("returns null and logs once when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    await expect(fetchPreviousEpisode("202")).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
