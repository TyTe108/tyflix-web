// The persistent chrome around every signed-in page: a top bar and menu
// drawer at 48rem and up, a bottom tab bar on viewports below that, and the
// routed page in a stable middle slot so rotating a phone across the
// breakpoint does not remount the page inside.
//
// App.tsx mounts this as a layout route nested inside ProtectedRoute, so it
// wraps everything from /library through /admin and never renders for /login or
// /request-access. Pages come through <Outlet />. Nothing here knows or cares
// which page is showing.
//
// The one piece of live data it owns is the badge-count poll for My Requests,
// My Issues, and Admin (a rollup). That endpoint is behind requireAuth and can
// fail; a failure leaves the last good counts alone and never surfaces an
// error in the nav.
import { useEffect, useState } from "react";
import { Outlet } from "react-router";
import { fetchBadgeCounts, type BadgeCounts } from "../api/badgeCounts";
import { useIsMobile } from "../hooks/useIsMobile";
import { DesktopNav } from "./DesktopNav";
import { MobileNav } from "./MobileNav";

const BADGE_COUNT_POLL_MS = 60_000;

/**
 * Layout route for the whole authenticated app: desktop top bar and menu
 * drawer, or mobile nav, plus an <Outlet /> for the current page.
 *
 * Hiding the Admin link from non-admins is cosmetic. The real gate is
 * AdminRoute on the client and the admin permission bit on the server.
 */
export function AppShell() {
  const isMobile = useIsMobile();
  const [badgeCounts, setBadgeCounts] = useState<BadgeCounts | null>(null);

  // Poll badge counts for every signed-in user, once a minute. A failed poll
  // leaves the previous value alone so a blip does not blank the nav.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const next = await fetchBadgeCounts();
        if (!cancelled) {
          setBadgeCounts(next);
        }
      } catch {
        // Transient failure: leave the last good counts (or none) alone.
      }
    };

    void load();
    const intervalId = window.setInterval(() => {
      void load();
    }, BADGE_COUNT_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  // One tree, stable child indexes: DesktopNav | content | mobile nav. React
  // reconciles by index, so swapping a two-branch layout would remount
  // <Outlet /> and take the player's fullscreen element and <video> with it.
  return (
    <div className={isMobile ? "app-shell app-shell--mobile" : "app-shell"}>
      {isMobile ? null : <DesktopNav badgeCounts={badgeCounts} />}

      <div className="app-content">
        <Outlet />
      </div>

      {isMobile ? <MobileNav badgeCounts={badgeCounts} /> : null}
    </div>
  );
}
