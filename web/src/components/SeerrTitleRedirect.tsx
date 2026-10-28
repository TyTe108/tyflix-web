// Replaces Seerr's /movie/:tmdbId and /tv/:tmdbId links with the title page.
//
// App.tsx mounts one of these per path, at the top level next to the
// catch-all and outside ProtectedRoute. It renders nothing: Navigate
// replaces the entry with /media/<mediaType>/<id> and the landing state from
// lib/landing.ts, and ProtectedRoute still guards /media. The id is
// forwarded URL-encoded, with no check and no other destination, so a bad
// id reaches MediaDetailPage's "Invalid media link." state. The path built
// here has no search or hash, so those are left behind.

import { Navigate, useParams } from "react-router";
import { landingState } from "../lib/landing";

/**
 * Replaces the current entry with /media/<mediaType>/<tmdbId>.
 *
 * `mediaType` is the route that mounted this, not a URL segment, so a /tv
 * link is not sent to a movie page. A missing :tmdbId throws. The route
 * requires that segment, and an empty path would miss the title page.
 */
export function SeerrTitleRedirect({
  mediaType,
}: {
  mediaType: "movie" | "tv";
}) {
  const { tmdbId } = useParams();
  if (tmdbId === undefined) {
    throw new Error("SeerrTitleRedirect requires a :tmdbId segment");
  }

  return (
    <Navigate
      to={`/media/${mediaType}/${encodeURIComponent(tmdbId)}`}
      replace
      state={landingState}
    />
  );
}
