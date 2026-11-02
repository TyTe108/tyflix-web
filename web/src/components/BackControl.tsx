// Back control for the player.
//
// WatchPage renders this in the header and in the error state. When an in-app
// page sits behind this entry, it pops one history entry. When this entry
// opened the visit, it goes to the Library with replace, so the browser's
// Back from that Library can't reopen the player. MediaDetailPage's Back
// applies the same rule inline with its own markup.
import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { isLandingLocation } from "../lib/landing";

/**
 * Back for one player entry.
 *
 * Pops when an in-app page sits behind this entry. Goes to the Library with
 * replace when this entry opened the visit, so the browser's Back from that
 * Library can't reopen the player.
 */
export function BackControl({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();

  if (isLandingLocation(location)) {
    return (
      <Link to="/" replace className={className}>
        {children}
      </Link>
    );
  }

  return (
    <button type="button" className={className} onClick={() => navigate(-1)}>
      {children}
    </button>
  );
}
