// Single source of truth for the authenticated primary nav destinations.
// AppShell (desktop sidebar) and MobileNav (bottom tabs + More sheet) both
// import from here so labels, order, paths, and icons cannot drift between the
// two renderers.
import type { ReactNode } from "react";

// One sidebar / tab / sheet entry. `adminOnly` hides the row from non-admins.
// `end` is react-router's exact-match flag for the active class, though no
// entry in NAV_ITEMS sets it today, so it's always undefined.
export type NavItem = {
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

const SettingsIcon = (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.2" />
    <path d="M12 18.8V21" />
    <path d="M4.9 6.3l1.6 1.6" />
    <path d="M17.5 16.1l1.6 1.6" />
    <path d="M3 12h2.2" />
    <path d="M18.8 12H21" />
    <path d="M4.9 17.7l1.6-1.6" />
    <path d="M17.5 7.9l1.6-1.6" />
  </svg>
);

const AdminIcon = (
  <svg {...iconProps}>
    <path d="M12 3 5 6v5c0 4.2 2.9 7.9 7 9 4.1-1.1 7-4.8 7-9V6z" />
  </svg>
);

export const LogoutIcon = (
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

// Three-dot glyph for the More tab that opens the overflow sheet.
export const MoreIcon = (
  <svg {...iconProps}>
    <circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

// Sidebar order, top to bottom. Library leads because "/" redirects there, so
// it's the first thing anyone sees after signing in.
export const NAV_ITEMS: NavItem[] = [
  { to: "/library", label: "Library", icon: LibraryIcon },
  { to: "/home", label: "Home", icon: HomeIcon },
  { to: "/discover", label: "Discover", icon: DiscoverIcon },
  { to: "/watchlist", label: "Watchlist", icon: WatchlistIcon },
  { to: "/requests", label: "My Requests", icon: RequestsIcon },
  { to: "/issues", label: "My Issues", icon: IssuesIcon },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
  { to: "/admin", label: "Admin", icon: AdminIcon, adminOnly: true },
];

// Bottom-tab destinations. Home stays in the More sheet because "/" redirects
// to /library, so Library is the real landing page.
const MOBILE_TAB_PATHS = [
  "/library",
  "/discover",
  "/watchlist",
  "/requests",
] as const;

const MOBILE_MORE_PATHS = ["/home", "/issues", "/settings", "/admin"] as const;

function itemsForPaths(paths: readonly string[]): NavItem[] {
  return paths.map((path) => {
    const item = NAV_ITEMS.find((entry) => entry.to === path);
    if (!item) {
      throw new Error(`NAV_ITEMS is missing path ${path}`);
    }
    return item;
  });
}

export const MOBILE_TAB_ITEMS: NavItem[] = itemsForPaths(MOBILE_TAB_PATHS);
export const MOBILE_MORE_ITEMS: NavItem[] = itemsForPaths(MOBILE_MORE_PATHS);
