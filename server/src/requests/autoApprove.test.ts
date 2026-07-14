import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SEERR_PERM_ADMIN,
  SEERR_PERM_AUTO_APPROVE,
  SEERR_PERM_AUTO_APPROVE_MOVIE,
  SEERR_PERM_AUTO_APPROVE_TV,
  shouldAutoApprove,
} from "./autoApprove";

describe("shouldAutoApprove", () => {
  it("returns true for ADMIN bit", () => {
    assert.equal(shouldAutoApprove(SEERR_PERM_ADMIN, "movie"), true);
    assert.equal(shouldAutoApprove(SEERR_PERM_ADMIN, "tv"), true);
  });

  it("returns true for AUTO_APPROVE bit on any media type", () => {
    assert.equal(shouldAutoApprove(SEERR_PERM_AUTO_APPROVE, "movie"), true);
    assert.equal(shouldAutoApprove(SEERR_PERM_AUTO_APPROVE, "tv"), true);
  });

  it("returns true for AUTO_APPROVE_MOVIE only on movies", () => {
    assert.equal(
      shouldAutoApprove(SEERR_PERM_AUTO_APPROVE_MOVIE, "movie"),
      true,
    );
    assert.equal(shouldAutoApprove(SEERR_PERM_AUTO_APPROVE_MOVIE, "tv"), false);
  });

  it("returns true for AUTO_APPROVE_TV only on tv", () => {
    assert.equal(shouldAutoApprove(SEERR_PERM_AUTO_APPROVE_TV, "tv"), true);
    assert.equal(
      shouldAutoApprove(SEERR_PERM_AUTO_APPROVE_TV, "movie"),
      false,
    );
  });

  it("returns false when no auto-approve bits are set", () => {
    assert.equal(shouldAutoApprove(0, "movie"), false);
    assert.equal(shouldAutoApprove(0, "tv"), false);
    assert.equal(shouldAutoApprove(32, "movie"), false);
  });

  it("combines bits (admin + others still true)", () => {
    assert.equal(
      shouldAutoApprove(SEERR_PERM_ADMIN | SEERR_PERM_AUTO_APPROVE_TV, "movie"),
      true,
    );
  });
});
