// The marker a redirect puts on a history entry that opens a visit.
//
// SeerrTitleRedirect sets it when it replaces /movie/:tmdbId or /tv/:tmdbId
// with the title page. MediaDetailPage reads it through isLandingState and
// treats that entry like a direct load: Back is a link home, because there
// is no in-app page behind it. A <Navigate replace> mints a fresh location
// key, so the key alone can't say that.
//
// History state is untrusted. isLandingState accepts only an object whose
// landing property is exactly true.
//
// The object is one shared value. Navigate lists `state` among its effect
// dependencies, and a new object on each render navigates again.

/**
 * Router state for an entry that opened the visit.
 *
 * Pass this object as Navigate's `state`. A fresh object per render would
 * retrigger that navigation.
 */
export const landingState: { landing: true } = { landing: true };

/**
 * Whether `state` marks the entry as the start of a visit.
 *
 * True only for a non-null object whose `landing` property is exactly
 * `true`. Null, a string, a number, and a missing property are not.
 */
export function isLandingState(state: unknown): boolean {
  if (typeof state !== "object" || state === null) {
    return false;
  }
  if (!("landing" in state)) {
    return false;
  }
  return state.landing === true;
}
