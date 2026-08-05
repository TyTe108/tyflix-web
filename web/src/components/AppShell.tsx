// The persistent chrome around every signed-in page: sidebar on the left on
// desktop, bottom tab bar on viewports below 48rem, and the routed page in the
// remaining space.
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
import { NavLink, Outlet } from "react-router-dom";
import {
  adminBadgeRollup,
  fetchBadgeCounts,
  type BadgeCounts,
} from "../api/badgeCounts";
import { useAuth } from "../auth/AuthContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { MobileNav } from "./MobileNav";
import { NavBadge } from "./NavBadge";
import { LogoutIcon, NAV_ITEMS } from "./navItems";

const BADGE_COUNT_POLL_MS = 60_000;

function badgeForPath(
  path: string,
  counts: BadgeCounts | null,
): { count: number; label: string } | null {
  if (counts === null) {
    return null;
  }

  if (path === "/requests") {
    const count = counts.mine.requests;
    return {
      count,
      label:
        count === 1
          ? "1 request in progress"
          : `${count} requests in progress`,
    };
  }

  if (path === "/issues") {
    const count = counts.mine.issues;
    return {
      count,
      label: count === 1 ? "1 open issue" : `${count} open issues`,
    };
  }

  if (path === "/admin") {
    const count = adminBadgeRollup(counts.admin);
    return {
      count,
      label:
        count === 1
          ? "1 admin item needing attention"
          : `${count} admin items needing attention`,
    };
  }

  return null;
}

/**
 * Layout route for the whole authenticated app: sidebar or mobile nav, plus an
 * <Outlet /> for the current page.
 *
 * Hiding the Admin link from non-admins is cosmetic. The real gate is
 * AdminRoute on the client and the admin permission bit on the server.
 */
export function AppShell() {
  const { user, isAdmin, logout } = useAuth();
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

  if (isMobile) {
    return (
      <div className="app-shell app-shell--mobile">
        <div className="app-content">
          <Outlet />
        </div>
        <MobileNav badgeCounts={badgeCounts} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        {/* Both brand marks are always in the DOM. A media query at 820px
            narrows the sidebar to a 64px rail and swaps the word for the T. */}
        <div className="sidebar-brand">
          <span className="sidebar-brand-full">Tyflix</span>
          <span className="sidebar-brand-short" aria-hidden="true">
            T
          </span>
        </div>

        {/* Primary nav. Admin-only rows are filtered out; Requests, Issues,
            and Admin carry badges when their counts are above zero. */}
        <nav className="sidebar-nav" aria-label="Primary">
          {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => {
            const badge = badgeForPath(item.to, badgeCounts);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  isActive ? "sidebar-link active" : "sidebar-link"
                }
              >
                <span className="sidebar-link-icon">
                  {item.icon}
                  {badge ? (
                    <NavBadge
                      count={badge.count}
                      label={badge.label}
                      className="sidebar-badge"
                    />
                  ) : null}
                </span>
                <span className="sidebar-link-label">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        {/* Footer: who's signed in, plus the way out. */}
        <div className="sidebar-footer">
          {user ? (
            <div className="sidebar-user">
              <span className="sidebar-user-name">{user.displayName}</span>
              {isAdmin ? (
                <span className="sidebar-admin-chip">admin</span>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            className="sidebar-logout"
            onClick={() => void logout()}
          >
            <span className="sidebar-link-icon">{LogoutIcon}</span>
            <span className="sidebar-link-label">Logout</span>
          </button>
        </div>
      </aside>

      <div className="app-content">
        <Outlet />
      </div>
    </div>
  );
}
