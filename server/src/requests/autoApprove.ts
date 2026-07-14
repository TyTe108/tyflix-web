import type { MediaType } from "../db/requests";

/** Seerr permission bits */
export const SEERR_PERM_ADMIN = 2;
export const SEERR_PERM_AUTO_APPROVE = 128;
export const SEERR_PERM_AUTO_APPROVE_MOVIE = 256;
export const SEERR_PERM_AUTO_APPROVE_TV = 512;

export function shouldAutoApprove(
  permissions: number,
  mediaType: MediaType,
): boolean {
  if ((permissions & SEERR_PERM_ADMIN) !== 0) {
    return true;
  }
  if ((permissions & SEERR_PERM_AUTO_APPROVE) !== 0) {
    return true;
  }
  if (
    mediaType === "movie" &&
    (permissions & SEERR_PERM_AUTO_APPROVE_MOVIE) !== 0
  ) {
    return true;
  }
  if (mediaType === "tv" && (permissions & SEERR_PERM_AUTO_APPROVE_TV) !== 0) {
    return true;
  }
  return false;
}
