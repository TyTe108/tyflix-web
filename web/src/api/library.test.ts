// The library image URL. Pure string building, so there is no fetch to stub.
import { describe, expect, it } from "vitest";
import { libraryImageUrl } from "./library";

const THUMB = "/library/metadata/501/thumb/11";

describe("libraryImageUrl", () => {
  // Guards the unsized proxy URL that posters and art still use.
  it("returns the proxied path with no size", () => {
    expect(libraryImageUrl(THUMB)).toBe(
      "/api/library/image?path=%2Flibrary%2Fmetadata%2F501%2Fthumb%2F11",
    );
  });

  // Guards the two sizes the server accepts. Any other size is a 400.
  it("appends 640x360 and 1280x720", () => {
    expect(libraryImageUrl(THUMB, "640x360")).toBe(
      "/api/library/image?path=%2Flibrary%2Fmetadata%2F501%2Fthumb%2F11&size=640x360",
    );
    expect(libraryImageUrl(THUMB, "1280x720")).toBe(
      "/api/library/image?path=%2Flibrary%2Fmetadata%2F501%2Fthumb%2F11&size=1280x720",
    );
  });
});
