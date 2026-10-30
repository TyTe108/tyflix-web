// Top bar and menu drawer for viewports at 48rem and up. AppShell mounts this
// instead of MobileNav when useIsMobile() is false; only one of the two is
// mounted at a time.
//
// Mirrors MobileNav: this file owns the drawer's open state, and the overlay
// is the shared BottomSheet so the scrim, Escape, and focus behaviour stay
// the same. The drawer has no panel of its own. BottomSheet's sheet class is
// only positioning; the list sits on the dimmed page. The close button lives
// in the drawer, drawn where the menu button sits, because the scrim (z-index
// 30) covers the top bar (z-index 20) while the drawer is open, so the bar's
// own button can't be clicked. Inside the panel it's also the first thing Tab
// reaches after BottomSheet moves focus in. The bar's button is hidden while
// the drawer is open so only one X shows.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router";
import {
  adminBadgeRollup,
  type BadgeCounts,
} from "../api/badgeCounts";
import type { AuthUser } from "../api/auth";
import { useAuth } from "../auth/AuthContext";
import { BottomSheet } from "./BottomSheet";
import { NavBadge } from "./NavBadge";
import { CloseIcon, MenuIcon, NAV_ITEMS } from "./navItems";

// The bar turns opaque once the page has scrolled past this.
const SCROLLED_AFTER_PX = 8;

type DesktopNavProps = {
  badgeCounts: BadgeCounts | null;
};

/**
 * Count and accessible label for the badge on a primary-nav path.
 * /requests, /issues, and /admin each have their own label. Every other
 * path, and a null count payload, returns null.
 */
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

function accountName(user: AuthUser): string {
  const displayName = user.displayName.trim();
  if (displayName !== "") {
    return displayName;
  }
  return user.plexUsername.trim();
}

function accountInitial(name: string): string {
  const [first] = Array.from(name);
  if (first === undefined) {
    return "";
  }
  return first.toUpperCase();
}

function attentionTotal(counts: BadgeCounts | null): number | null {
  if (counts === null) {
    return null;
  }
  return (
    counts.mine.requests +
    counts.mine.issues +
    adminBadgeRollup(counts.admin)
  );
}

function menuButtonLabel(total: number | null): string {
  if (total === null || total <= 0) {
    return "Menu";
  }
  if (total === 1) {
    return "Menu, 1 item needing attention";
  }
  return `Menu, ${total} items needing attention`;
}

/**
 * Fixed top bar (menu button, wordmark, account link) and the menu drawer.
 * AppShell mounts this at 48rem and up and passes in the badge counts it polls.
 */
export function DesktopNav({ badgeCounts }: DesktopNavProps) {
  const { user, isAdmin, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [scrolled, setScrolled] = useState(
    () => window.scrollY > SCROLLED_AFTER_PX,
  );

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > SCROLLED_AFTER_PX);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
  }, []);

  const total = attentionTotal(badgeCounts);
  const name = user ? accountName(user) : "";

  return (
    <>
      <header className={scrolled ? "topbar topbar--scrolled" : "topbar"}>
        <button
          ref={menuButtonRef}
          type="button"
          className="topbar-menu"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          aria-label={menuButtonLabel(total)}
          onClick={() => setMenuOpen(true)}
        >
          {MenuIcon}
          {total !== null && total > 0 ? (
            <span
              className="topbar-menu-dot"
              aria-hidden="true"
              data-testid="menu-attention-dot"
            />
          ) : null}
        </button>
        <Link to="/library" className="topbar-wordmark">
          Tyflix
        </Link>
        {user ? (
          <Link
            to="/settings"
            className="topbar-account"
            aria-label={
              name === "" ? "Account settings" : `Account settings, ${name}`
            }
          >
            <span className="topbar-avatar" aria-hidden="true">{accountInitial(name)}</span>
          </Link>
        ) : null}
      </header>

      <BottomSheet
        open={menuOpen}
        onClose={closeMenu}
        returnFocusRef={menuButtonRef}
        aria-label="Menu"
        scrimClassName="nav-drawer-scrim"
        sheetClassName="nav-drawer"
        scrimTestId="nav-drawer-scrim"
      >
        <button
          type="button"
          className="nav-drawer-close"
          aria-label="Close menu"
          onClick={closeMenu}
        >
          {CloseIcon}
        </button>
        <div className="nav-drawer-scroll">
          <div className="nav-drawer-list">
            <nav aria-label="Primary">
              {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map(
                (item) => {
                  const badge = badgeForPath(item.to, badgeCounts);
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) =>
                        isActive ? "nav-drawer-link active" : "nav-drawer-link"
                      }
                      onClick={closeMenu}
                    >
                      {item.label}
                      {badge ? (
                        <NavBadge
                          count={badge.count}
                          label={badge.label}
                          className="nav-drawer-badge"
                        />
                      ) : null}
                    </NavLink>
                  );
                },
              )}
            </nav>
            <div className="nav-drawer-divider" />
            {user ? (
              <div className="nav-drawer-user">
                <span className="nav-drawer-user-name">{user.displayName}</span>
                {isAdmin ? (
                  <span className="nav-drawer-admin-chip">admin</span>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              className="nav-drawer-link"
              onClick={() => {
                closeMenu();
                void logout();
              }}
            >
              Logout
            </button>
          </div>
        </div>
      </BottomSheet>
    </>
  );
}
