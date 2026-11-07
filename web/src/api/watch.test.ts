// URL-level coverage for the previous-episode lookup. globalThis.fetch is
// stubbed so we can assert the request the helper builds, same pattern as
// me.test.ts. console.error is a no-op spy so a failure log is counted without
// printing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  audioIdToSelect,
  fetchPreviousEpisode,
  pickActiveAudioId,
  selectAudio,
  type AudioStream,
} from "./watch";

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

function audioTrack(
  id: string,
  flags: { selected?: boolean; default?: boolean } = {},
): AudioStream {
  return {
    id,
    language: null,
    codec: null,
    channels: null,
    title: null,
    default: flags.default ?? false,
    selected: flags.selected ?? false,
  };
}

describe("selectAudio", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PUTs /api/watch/audio/:ratingKey with the stream id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(selectAudio("9304", "74295")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/watch/audio/9304", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioStreamID: "74295" }),
    });
  });

  it("throws the server's error message on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({
          error: "Plex server /library/parts/15133 failed (500)",
        }),
      }),
    );

    await expect(selectAudio("9304", "74295")).rejects.toThrow(
      "Plex server /library/parts/15133 failed (500)",
    );
  });

  it("throws Failed to select audio when the failure body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json");
        },
      }),
    );

    await expect(selectAudio("9304", "74295")).rejects.toThrow(
      "Failed to select audio (500)",
    );
  });

  it("propagates a rejected fetch unchanged", async () => {
    const failure = new Error("network down");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));

    await expect(selectAudio("9304", "74295")).rejects.toBe(failure);
  });
});

describe("pickActiveAudioId", () => {
  it("returns the selected track ahead of the container default", () => {
    expect(
      pickActiveAudioId([
        audioTrack("por", { default: true }),
        audioTrack("kor", { selected: true }),
      ]),
    ).toBe("kor");
  });

  it("returns the default track when none is selected", () => {
    expect(
      pickActiveAudioId([
        audioTrack("por", { default: true }),
        audioTrack("kor"),
      ]),
    ).toBe("por");
  });

  it("returns the first track when none is selected or default", () => {
    expect(pickActiveAudioId([audioTrack("a"), audioTrack("b")])).toBe("a");
  });

  it("returns null for an empty list", () => {
    expect(pickActiveAudioId([])).toBeNull();
  });

  it("returns the first selected track when two say selected", () => {
    expect(
      pickActiveAudioId([
        audioTrack("first", { selected: true }),
        audioTrack("second", { selected: true }),
      ]),
    ).toBe("first");
  });
});

describe("audioIdToSelect", () => {
  const tracks = [
    audioTrack("por", { default: true }),
    audioTrack("kor", { selected: true }),
  ];

  it("returns null when the request is null", () => {
    expect(audioIdToSelect(null, tracks)).toBeNull();
  });

  it("returns null when the request is the track Plex will play", () => {
    expect(audioIdToSelect("kor", tracks)).toBeNull();
  });

  it("returns the default id when another track is selected", () => {
    expect(audioIdToSelect("por", tracks)).toBe("por");
  });

  it("returns a different request", () => {
    expect(audioIdToSelect("eng", tracks)).toBe("eng");
  });

  it("returns the request when the track list is empty", () => {
    expect(audioIdToSelect("eng", [])).toBe("eng");
  });
});
