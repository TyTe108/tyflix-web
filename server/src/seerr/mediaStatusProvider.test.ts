import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMediaStatusProvider } from "./mediaStatusProvider";

describe("createMediaStatusProvider", () => {
  it("builds the media status map and caches it within the TTL", async () => {
    let calls = 0;
    const provider = createMediaStatusProvider({
      async listMedia() {
        calls += 1;
        return [
          { id: 10, tmdbId: 603, mediaType: "movie", status: 5 },
          { id: 20, tmdbId: 1396, mediaType: "tv", status: 4 },
          { id: 30, tmdbId: 1, mediaType: "movie", status: 99 },
        ];
      },
    });

    const first = await provider.getStatusMap();
    const second = await provider.getStatusMap();

    assert.equal(first.get("movie:603"), "available");
    assert.equal(first.get("tv:1396"), "partially_available");
    assert.equal(first.has("movie:1"), false);
    assert.equal(second, first);
    assert.equal(await provider.getMediaId("movie", 603), 10);
    assert.equal(await provider.getMediaId("tv", 603), null);
    assert.equal(calls, 1);
  });

  it("returns an empty map when loading media fails", async () => {
    const provider = createMediaStatusProvider({
      async listMedia() {
        throw new Error("Seerr unavailable");
      },
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const statuses = await provider.getStatusMap();
      assert.equal(statuses.size, 0);
      assert.equal(await provider.getMediaId("movie", 603), null);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
