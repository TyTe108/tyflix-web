// The persistent chrome around every signed-in page: sidebar on the left on
// desktop, bottom tab bar on viewports below 48rem, and the routed page in the
// remaining space.
//
// App.tsx mounts this as a layout route nested inside ProtectedRoute, so it
// wraps everything from /library through /admin and never renders for /login or
// /request-access. Pages come through <Outlet />. Nothing here knows or cares
// which page is showing.
//
// The one piece of live data it owns is the pending access-request count, shown
// as a badge on the Admin link (desktop) or the More tab / Admin sheet row
// (mobile). That endpoint is admin-only and can be switched off, so a failure
// just leaves the badge absent.
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { fetchAccessRequestPendingCount } from "../api/accessRequests";
import { useAuth } from "../auth/AuthContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { MobileNav } from "./MobileNav";
import { LogoutIcon, NAV_ITEMS } from "./navItems";

const PENDING_COUNT_POLL_MS = 60_000;

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
  const [pendingAccessCount, setPendingAccessCount] = useState<number | null>(
    null,
  );

  // Poll the pending access-request count for the Admin / More badge, once a
  // minute for as long as an admin is signed in. Re-runs when the admin flag
  // changes, which covers a logout landing on a non-admin session.
  useEffect(() => {
    if (!isAdmin) {
      setPendingAccessCount(null);
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        const { pending } = await fetchAccessRequestPendingCount();
        if (!cancelled) {
          setPendingAccessCount(pending);
        }
      } catch {
        // Feature off (404) or transient failure: leave the nav looking normal.
      }
    };

    void load();
    const intervalId = window.setInterval(() => {
      void load();
    }, PENDING_COUNT_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isAdmin]);

  if (isMobile) {
    return (
      <div className="app-shell app-shell--mobile">
        <div className="app-content">
          <Outlet />
        </div>
        <MobileNav pendingAccessCount={pendingAccessCount} />
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

        {/* Primary nav. Admin-only rows are filtered out, and the Admin row
            carries the pending-request badge when there's anything waiting. */}
        <nav className="sidebar-nav" aria-label="Primary">
          {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => {
            const showBadge =
              item.to === "/admin" &&
              pendingAccessCount !== null &&
              pendingAccessCount > 0;
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
                  {showBadge ? (
                    <span
                      className="sidebar-badge"
                      aria-label={`${pendingAccessCount} pending access ${
                        pendingAccessCount === 1 ? "request" : "requests"
                      }`}
                    >
                      {pendingAccessCount > 99 ? "99+" : pendingAccessCount}
                    </span>
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
