// isLandingState, the guard MediaDetailPage uses on location.state. History
// state is untrusted, so the cases here are the ones that must not count as
// a landing entry. SeerrTitleRedirect is what writes the marker.
import { describe, expect, it } from "vitest";
import { isLandingState } from "./landing";

describe("isLandingState", () => {
  it("is true for { landing: true }", () => {
    expect(isLandingState({ landing: true })).toBe(true);
  });

  it("is false for null", () => {
    expect(isLandingState(null)).toBe(false);
  });

  it("is false for undefined", () => {
    expect(isLandingState(undefined)).toBe(false);
  });

  it("is false for a string", () => {
    expect(isLandingState("landing")).toBe(false);
  });

  it('is false for { landing: "true" }', () => {
    expect(isLandingState({ landing: "true" })).toBe(false);
  });

  it("is false for { landing: 1 }", () => {
    expect(isLandingState({ landing: 1 })).toBe(false);
  });

  it("is false for {}", () => {
    expect(isLandingState({})).toBe(false);
  });
});
