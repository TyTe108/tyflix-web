// returnToState and resolveReturnTo. ProtectedRoute and AdminRoute build the
// state; LoginPage resolves it before navigating. History state is untrusted,
// so the rejects here are the ones that must come back as "/".
import { describe, expect, it } from "vitest";
import { resolveReturnTo, returnToState } from "./returnTo";

describe("returnToState", () => {
  it("concatenates pathname, search and hash", () => {
    expect(
      returnToState({
        pathname: "/media/tv/1396",
        search: "?x=1",
        hash: "#h",
      }),
    ).toEqual({ returnTo: "/media/tv/1396?x=1#h" });
  });
});

describe("resolveReturnTo", () => {
  it("keeps a same-app path, including its search and hash", () => {
    expect(
      resolveReturnTo({ returnTo: "/media/tv/1396?x=1#h" }),
    ).toBe("/media/tv/1396?x=1#h");
  });

  it("keeps / and a path that only starts like /login", () => {
    expect(resolveReturnTo({ returnTo: "/" })).toBe("/");
    expect(resolveReturnTo({ returnTo: "/loginish" })).toBe("/loginish");
  });

  it.each([
    ["missing state", null],
    ["undefined", undefined],
    ["a non-object", "https://evil.example"],
    ["a non-string returnTo", { returnTo: 1 }],
    ["https://evil.example", { returnTo: "https://evil.example" }],
    ["//evil.example", { returnTo: "//evil.example" }],
    ["/\\evil.example", { returnTo: "/\\evil.example" }],
    ["/login", { returnTo: "/login" }],
    ["/login?x=1", { returnTo: "/login?x=1" }],
    ["a path under /login", { returnTo: "/login/extra" }],
  ])("resolves %s to /", (_label, state) => {
    expect(resolveReturnTo(state)).toBe("/");
  });
});
