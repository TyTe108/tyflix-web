// Bottom tab bar + More sheet for viewports below 48rem. AppShell mounts this
// instead of the desktop sidebar when useIsMobile() is true; only one primary
// nav landmark exists at a time.
//
// Destinations come from navItems.tsx. The pending-access badge is passed in
// from AppShell, which still owns the poll — this file only decides where the
// badge renders (More tab, and Admin inside the sheet).
import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import {
  LogoutIcon,
  MOBILE_MORE_ITEMS,
  MOBILE_TAB_ITEMS,
  MoreIcon,
} from "./navItems";

type MobileNavProps = {
  pendingAccessCount: number | null;
};

function PendingBadge({ count }: { count: number }) {
  return (
    <span
      className="mobile-nav-badge"
      aria-label={`${count} pending access ${
        count === 1 ? "request" : "requests"
      }`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * Fixed bottom tabs (Library, Discover, Watchlist, My Requests, More) and an
 * on-demand More sheet for Home, My Issues, Admin, identity, and Logout.
 */
export function MobileNav({ pendingAccessCount }: MobileNavProps) {
  const { user, isAdmin, logout } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const wasMoreOpenRef = useRef(false);

  const showBadge =
    pendingAccessCount !== null && pendingAccessCount > 0;

  useEffect(() => {
    if (!moreOpen) {
      return;
    }

    sheetRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMoreOpen(false);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);

  // Return focus to the More trigger after the sheet unmounts.
  useEffect(() => {
    if (wasMoreOpenRef.current && !moreOpen) {
      moreButtonRef.current?.focus();
    }
    wasMoreOpenRef.current = moreOpen;
  }, [moreOpen]);

  const closeMore = () => {
    setMoreOpen(false);
  };

  return (
    <>
      <nav className="mobile-nav" aria-label="Primary">
        {MOBILE_TAB_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              isActive ? "mobile-nav-tab active" : "mobile-nav-tab"
            }
          >
            <span className="mobile-nav-tab-icon">{item.icon}</span>
            <span className="mobile-nav-tab-label">{item.label}</span>
          </NavLink>
        ))}

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
            {showBadge && pendingAccessCount !== null ? (
              <PendingBadge count={pendingAccessCount} />
            ) : null}
          </span>
          <span className="mobile-nav-tab-label">More</span>
        </button>
      </nav>

      {moreOpen ? (
        <div
          className="mobile-nav-scrim"
          data-testid="mobile-nav-scrim"
          onClick={closeMore}
        >
          <div
            ref={sheetRef}
            className="mobile-nav-sheet"
            role="dialog"
            aria-label="More"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mobile-nav-sheet-nav">
              {MOBILE_MORE_ITEMS.filter(
                (item) => !item.adminOnly || isAdmin,
              ).map((item) => {
                const itemBadge =
                  item.to === "/admin" && showBadge && pendingAccessCount !== null;
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
                      {itemBadge ? (
                        <PendingBadge count={pendingAccessCount} />
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
          </div>
        </div>
      ) : null}
    </>
  );
}
