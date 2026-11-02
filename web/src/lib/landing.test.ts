// isLandingState, the guard MediaDetailPage uses on location.state. History
// state is untrusted, so the cases here are the ones that must not count as
// a landing entry. SeerrTitleRedirect is what writes the marker.
import { describe, expect, it } from "vitest";
import { isLandingLocation, isLandingState } from "./landing";

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

describe("isLandingLocation", () => {
  it('is true when the key is "default", whatever the state', () => {
    expect(isLandingLocation({ key: "default", state: null })).toBe(true);
    expect(isLandingLocation({ key: "default", state: undefined })).toBe(true);
    expect(
      isLandingLocation({ key: "default", state: { enterFullscreen: true } }),
    ).toBe(true);
    expect(
      isLandingLocation({ key: "default", state: { landing: "true" } }),
    ).toBe(true);
    expect(isLandingLocation({ key: "default", state: { landing: 1 } })).toBe(
      true,
    );
    expect(
      isLandingLocation({ key: "default", state: { landing: true } }),
    ).toBe(true);
  });

  it("is true when the state passes isLandingState", () => {
    expect(
      isLandingLocation({ key: "abc", state: { landing: true } }),
    ).toBe(true);
  });

  it("is false for any other key with null, fullscreen state, or a look-alike", () => {
    expect(isLandingLocation({ key: "abc", state: null })).toBe(false);
    expect(
      isLandingLocation({ key: "abc", state: { enterFullscreen: true } }),
    ).toBe(false);
    expect(isLandingLocation({ key: "abc", state: { landing: "true" } })).toBe(
      false,
    );
    expect(isLandingLocation({ key: "abc", state: { landing: 1 } })).toBe(
      false,
    );
  });
});
