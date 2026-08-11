// Bottom tab bar + More sheet for viewports below 48rem. AppShell mounts this
// instead of the desktop sidebar when useIsMobile() is true; only one primary
// nav landmark exists at a time.
//
// Destinations come from navItems.tsx. Badge counts are passed in from
// AppShell, which owns the /api/me/badge-counts poll — this file only decides
// where each badge renders (My Requests on the tab bar; My Issues and Admin
// inside the sheet; More as the rollup of sheet-internal badges).
//
// The More overlay is the shared BottomSheet so Library filters (and later
// Dropdown) get the same scrim / Escape / focus behaviour.
import { useCallback, useRef, useState } from "react";
import { NavLink } from "react-router";
import {
  adminBadgeRollup,
  type BadgeCounts,
} from "../api/badgeCounts";
import { useAuth } from "../auth/AuthContext";
import { BottomSheet } from "./BottomSheet";
import { NavBadge } from "./NavBadge";
import {
  LogoutIcon,
  MOBILE_MORE_ITEMS,
  MOBILE_TAB_ITEMS,
  MoreIcon,
} from "./navItems";

type MobileNavProps = {
  badgeCounts: BadgeCounts | null;
};

/**
 * Fixed bottom tabs (Library, Discover, Watchlist, My Requests, More) and an
 * on-demand More sheet for Home, My Issues, Admin, identity, and Logout.
 */
export function MobileNav({ badgeCounts }: MobileNavProps) {
  const { user, isAdmin, logout } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  const mineRequests = badgeCounts?.mine.requests ?? 0;
  const mineIssues = badgeCounts?.mine.issues ?? 0;
  const adminCount = adminBadgeRollup(badgeCounts?.admin ?? null);
  const moreCount = mineIssues + adminCount;

  const closeMore = useCallback(() => {
    setMoreOpen(false);
  }, []);

  return (
    <>
      <nav className="mobile-nav" aria-label="Primary">
        {MOBILE_TAB_ITEMS.map((item) => {
          const requestsBadge =
            item.to === "/requests"
              ? {
                  count: mineRequests,
                  label:
                    mineRequests === 1
                      ? "1 request in progress"
                      : `${mineRequests} requests in progress`,
                }
              : null;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                isActive ? "mobile-nav-tab active" : "mobile-nav-tab"
              }
            >
              <span className="mobile-nav-tab-icon">
                {item.icon}
                {requestsBadge ? (
                  <NavBadge
                    count={requestsBadge.count}
                    label={requestsBadge.label}
                    className="mobile-nav-badge"
                  />
                ) : null}
              </span>
              <span className="mobile-nav-tab-label">{item.label}</span>
            </NavLink>
          );
        })}

        <button
          ref={moreButtonRef}
          type="button"
          className={
            moreOpen ? "mobile-nav-tab active" : "mobile-nav-tab"
          }
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          onClick={() => setMoreOpen(true)}
        >
          <span className="mobile-nav-tab-icon">
            {MoreIcon}
            <NavBadge
              count={moreCount}
              label={
                moreCount === 1
                  ? "1 item needing attention"
                  : `${moreCount} items needing attention`
              }
              className="mobile-nav-badge"
            />
          </span>
          <span className="mobile-nav-tab-label">More</span>
        </button>
      </nav>

      <BottomSheet
        open={moreOpen}
        onClose={closeMore}
        returnFocusRef={moreButtonRef}
        aria-label="More"
        scrimClassName="mobile-nav-scrim"
        sheetClassName="mobile-nav-sheet"
        scrimTestId="mobile-nav-scrim"
      >
        <div className="mobile-nav-sheet-nav">
          {MOBILE_MORE_ITEMS.filter(
            (item) => !item.adminOnly || isAdmin,
          ).map((item) => {
            const badge =
              item.to === "/issues"
                ? {
                    count: mineIssues,
                    label:
                      mineIssues === 1
                        ? "1 open issue"
                        : `${mineIssues} open issues`,
                  }
                : item.to === "/admin"
                  ? {
                      count: adminCount,
                      label:
                        adminCount === 1
                          ? "1 admin item needing attention"
                          : `${adminCount} admin items needing attention`,
                    }
                  : null;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  isActive
                    ? "mobile-nav-sheet-link active"
                    : "mobile-nav-sheet-link"
                }
                onClick={closeMore}
              >
                <span className="mobile-nav-tab-icon">
                  {item.icon}
                  {badge ? (
                    <NavBadge
                      count={badge.count}
                      label={badge.label}
                      className="mobile-nav-badge"
                    />
                  ) : null}
                </span>
                <span className="mobile-nav-sheet-label">{item.label}</span>
              </NavLink>
            );
          })}
        </div>

        <div className="mobile-nav-sheet-footer">
          {user ? (
            <div className="mobile-nav-sheet-user">
              <span className="mobile-nav-sheet-user-name">
                {user.displayName}
              </span>
              {isAdmin ? (
                <span className="mobile-nav-sheet-admin-chip">admin</span>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            className="mobile-nav-sheet-logout"
            onClick={() => {
              closeMore();
              void logout();
            }}
          >
            <span className="mobile-nav-tab-icon">{LogoutIcon}</span>
            <span className="mobile-nav-sheet-label">Logout</span>
          </button>
        </div>
      </BottomSheet>
    </>
  );
}
