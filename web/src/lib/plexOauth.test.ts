// Coverage for the browser-side Plex PIN helpers and completePlexLogin
// response mapping. fetch is stubbed; popup / e2e login stay on the manual
// smoke checklist.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completePlexLogin } from "../api/auth";
import {
  buildPlexAuthUrl,
  checkPlexPin,
  createPlexPin,
  getPlexClientId,
} from "./plexOauth";

const STORAGE_KEY = "tyflix.plexClientId";

describe("getPlexClientId", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("mints once with crypto.randomUUID and reuses the stored value", () => {
    const randomUUID = vi.fn(() => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    vi.stubGlobal("crypto", { randomUUID, getRandomValues: undefined });

    const first = getPlexClientId();
    const second = getPlexClientId();

    expect(first).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(second).toBe(first);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(first);
  });

  it("falls back to getRandomValues when randomUUID is missing", () => {
    const getRandomValues = vi.fn((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = (i * 17) % 256;
      }
      return arr;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    const id = getPlexClientId();

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(getRandomValues).toHaveBeenCalled();
    expect(getPlexClientId()).toBe(id);
  });

  it("throws a clear Error when neither crypto API exists", () => {
    vi.stubGlobal("crypto", {});

    expect(() => getPlexClientId()).toThrow(/crypto/i);
  });
});

describe("createPlexPin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the exact URL and headers and returns id/code", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 42, code: "ABCD" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const pin = await createPlexPin("client-id-1");

    expect(pin).toEqual({ id: 42, code: "ABCD" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://plex.tv/api/v2/pins?strong=true");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "X-Plex-Client-Identifier": "client-id-1",
        "X-Plex-Product": "Tyflix",
        Accept: "application/json",
      },
    });
  });

  it("rejects when the body is missing id or code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 1 }),
      }),
    );

    await expect(createPlexPin("client-id-1")).rejects.toThrow(/code/i);
  });
});

describe("buildPlexAuthUrl", () => {
  it("includes the encoded clientID, code, and product", () => {
    const url = buildPlexAuthUrl("CODE/1", "id with spaces");

    expect(url.startsWith("https://app.plex.tv/auth#?")).toBe(true);
    const query = url.slice("https://app.plex.tv/auth#?".length);
    const params = new URLSearchParams(query);
    expect(params.get("clientID")).toBe("id with spaces");
    expect(params.get("code")).toBe("CODE/1");
    expect(params.get("context[device][product]")).toBe("Tyflix");
  });
});

describe("checkPlexPin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns authToken null when the token is absent (keep polling)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 7, authToken: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkPlexPin(7, "client-id-1")).resolves.toEqual({
      authToken: null,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://plex.tv/api/v2/pins/7");
    expect(init).toMatchObject({
      method: "GET",
      headers: {
        "X-Plex-Client-Identifier": "client-id-1",
        Accept: "application/json",
      },
    });
  });

  it("returns the authToken when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ authToken: "plex-token-abc" }),
      }),
    );

    await expect(checkPlexPin(7, "client-id-1")).resolves.toEqual({
      authToken: "plex-token-abc",
    });
  });

  it("throws on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      }),
    );

    await expect(checkPlexPin(7, "client-id-1")).rejects.toThrow(/500/);
  });
});

describe("completePlexLogin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps 2xx status ok to kind ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          user: {
            seerrUserId: 1,
            plexId: 2,
            plexUsername: "alice",
            displayName: "Alice",
            avatar: null,
            permissions: 0,
          },
          isAdmin: false,
        }),
      }),
    );

    const result = await completePlexLogin("token");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.data.user.plexUsername).toBe("alice");
    }
  });

  it("maps 403 to kind forbidden with the server message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          status: "forbidden",
          message: "Your Plex account isn't a Tyflix member.",
        }),
      }),
    );

    await expect(completePlexLogin("token")).resolves.toEqual({
      kind: "forbidden",
      message: "Your Plex account isn't a Tyflix member.",
    });
  });

  it("maps non-ok (including 401) to kind error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: "invalid authToken" }),
      }),
    );

    const result = await completePlexLogin("token");
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/401|Plex|login/i);
    }
  });

  it("maps a network throw to kind error and never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    const result = await completePlexLogin("token");
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("POSTs JSON {authToken} to /api/auth/plex/complete", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        user: {
          seerrUserId: 1,
          plexId: 2,
          plexUsername: "alice",
          displayName: "Alice",
          avatar: null,
          permissions: 0,
        },
        isAdmin: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await completePlexLogin("client-token-xyz");

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/plex/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authToken: "client-token-xyz" }),
    });
  });
});
