// The persistent chrome around every signed-in page: sidebar on the left, the
// routed page on the right.
//
// App.tsx mounts this as a layout route nested inside ProtectedRoute, so it
// wraps everything from /library through /admin and never renders for /login or
// /request-access. Pages come through <Outlet />. Nothing here knows or cares
// which page is showing.
//
// The one piece of live data it owns is the pending access-request count, shown
// as a badge on the Admin link. That endpoint is admin-only and can be switched
// off, so a failure just leaves the badge absent.
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { fetchAccessRequestPendingCount } from "../api/accessRequests";
import { useAuth } from "../auth/AuthContext";

// One sidebar entry. `adminOnly` hides the row from non-admins. `end` is
// react-router's exact-match flag for the active class, though no entry in
// NAV_ITEMS sets it today, so it's always undefined.
type NavItem = {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
  adminOnly?: boolean;
};

// Shared stroke geometry so the nav glyphs below stay visually consistent.
const iconProps = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const HomeIcon = (
  <svg {...iconProps}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
    <path d="M9.5 21v-6h5v6" />
  </svg>
);

const DiscoverIcon = (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5z" />
  </svg>
);

const WatchlistIcon = (
  <svg {...iconProps}>
    <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
  </svg>
);

const RequestsIcon = (
  <svg {...iconProps}>
    <path d="M4 5h16" />
    <path d="M4 12h16" />
    <path d="M4 19h10" />
  </svg>
);

const IssuesIcon = (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5" />
    <path d="M12 16h.01" />
  </svg>
);

const AdminIcon = (
  <svg {...iconProps}>
    <path d="M12 3 5 6v5c0 4.2 2.9 7.9 7 9 4.1-1.1 7-4.8 7-9V6z" />
  </svg>
);

const LogoutIcon = (
  <svg {...iconProps}>
    <path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" />
    <path d="M10 8 6 12l4 4" />
    <path d="M6 12h10" />
  </svg>
);

const LibraryIcon = (
  <svg {...iconProps}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

// Sidebar order, top to bottom. Library leads because "/" redirects there, so
// it's the first thing anyone sees after signing in.
const NAV_ITEMS: NavItem[] = [
  { to: "/library", label: "Library", icon: LibraryIcon },
  { to: "/home", label: "Home", icon: HomeIcon },
  { to: "/discover", label: "Discover", icon: DiscoverIcon },
  { to: "/watchlist", label: "Watchlist", icon: WatchlistIcon },
  { to: "/requests", label: "My Requests", icon: RequestsIcon },
  { to: "/issues", label: "My Issues", icon: IssuesIcon },
  { to: "/admin", label: "Admin", icon: AdminIcon, adminOnly: true },
];

const PENDING_COUNT_POLL_MS = 60_000;

/**
 * Layout route for the whole authenticated app: sidebar, nav, signed-in user
 * footer, and an <Outlet /> for the current page.
 *
 * Hiding the Admin link from non-admins is cosmetic. The real gate is
 * AdminRoute on the client and the admin permission bit on the server.
 */
export function AppShell() {
  const { user, isAdmin, logout } = useAuth();
  const [pendingAccessCount, setPendingAccessCount] = useState<number | null>(
    null,
  );

  // Poll the pending access-request count for the Admin badge, once a minute
  // for as long as an admin is signed in. Re-runs when the admin flag changes,
  // which covers a logout landing on a non-admin session.
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
