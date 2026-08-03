// URL-level coverage for admin API helpers. The api module is not mocked here:
// globalThis.fetch is stubbed so we can assert the request the helper builds.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBlocklist } from "./admin";

describe("fetchBlocklist", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("issues a request whose URL contains the take and skip query", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [],
        total: 0,
        take: 25,
        skip: 25,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchBlocklist({ take: 25, skip: 25 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("take=25");
    expect(url).toContain("skip=25");
  });
});
