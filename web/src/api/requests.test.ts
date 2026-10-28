import { afterEach, describe, expect, it, vi } from "vitest";
import { approveRequest, declineRequest, fetchAllRequests } from "./requests";

describe("fetchAllRequests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes the server error text from a 502 JSON body", async () => {
    stubFetch(502, { error: "TMDB /movie/300 failed (429)" });
    await expect(messageOf(fetchAllRequests())).resolves.toBe(
      "Failed to load all requests (502): TMDB /movie/300 failed (429)",
    );
  });

  it("keeps the status-only message when the body is not JSON", async () => {
    stubFetch(502, undefined, true);
    await expect(messageOf(fetchAllRequests())).resolves.toBe(
      "Failed to load all requests (502)",
    );
  });

  it("keeps the status-only message when the body has no error field", async () => {
    stubFetch(502, {});
    await expect(messageOf(fetchAllRequests())).resolves.toBe(
      "Failed to load all requests (502)",
    );
  });

  it("keeps the status-only message when error is not a string", async () => {
    stubFetch(502, { error: 7 });
    await expect(messageOf(fetchAllRequests())).resolves.toBe(
      "Failed to load all requests (502)",
    );
  });

  it("keeps the status-only message when error is blank", async () => {
    stubFetch(502, { error: "   " });
    await expect(messageOf(fetchAllRequests())).resolves.toBe(
      "Failed to load all requests (502)",
    );
  });

  it("includes the server error text from a 403 JSON body", async () => {
    stubFetch(403, { error: "forbidden" });
    await expect(messageOf(fetchAllRequests())).resolves.toBe(
      "Failed to load all requests (403): forbidden",
    );
  });

  it("resolves results on 200", async () => {
    const results = [{ id: 12, title: "Stub Movie 100" }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ results }),
      }),
    );
    await expect(fetchAllRequests()).resolves.toEqual(results);
  });
});

describe("approveRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes the server error text from a 409 JSON body", async () => {
    stubFetch(409, { error: "request is not pending" });
    await expect(messageOf(approveRequest(283))).resolves.toBe(
      "Failed to approve request (409): request is not pending",
    );
  });

  it("keeps the status-only message when the body is not JSON", async () => {
    stubFetch(502, undefined, true);
    await expect(messageOf(approveRequest(283))).resolves.toBe(
      "Failed to approve request (502)",
    );
  });

  it("keeps the status-only message when error is blank", async () => {
    stubFetch(502, { error: "   " });
    await expect(messageOf(approveRequest(283))).resolves.toBe(
      "Failed to approve request (502)",
    );
  });

  it("resolves the body on 200", async () => {
    const request = { id: 283, title: "Stub Movie 100" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => request,
      }),
    );
    await expect(approveRequest(283)).resolves.toEqual(request);
  });
});

describe("declineRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes the server error text from a 409 JSON body", async () => {
    stubFetch(409, { error: "request is not pending" });
    await expect(messageOf(declineRequest(283))).resolves.toBe(
      "Failed to decline request (409): request is not pending",
    );
  });

  it("keeps the status-only message when the body is not JSON", async () => {
    stubFetch(502, undefined, true);
    await expect(messageOf(declineRequest(283))).resolves.toBe(
      "Failed to decline request (502)",
    );
  });
});

function stubFetch(status: number, body: unknown, jsonThrows = false): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: async () => {
        if (jsonThrows) {
          throw new Error("invalid json");
        }
        return body;
      },
    }),
  );
}

async function messageOf(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the call to reject");
}
