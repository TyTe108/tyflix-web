// Shared numeric badge for primary-nav destinations. AppShell (sidebar) and
// MobileNav (bottom tabs + More sheet) both render through this so the 99+
// cap and "render nothing at 0" rule cannot drift.
//
// className is a prop rather than baked in because the desktop sidebar and
// the mobile tab bar already have their own CSS rules (.sidebar-badge /
// .mobile-nav-badge); this component only owns the markup and the count text.

type NavBadgeProps = {
  count: number;
  label: string;
  className: string;
};

/**
 * Renders a count badge, or nothing when count is 0 so empty work queues stay
 * visually quiet.
 */
export function NavBadge({ count, label, className }: NavBadgeProps) {
  if (count <= 0) {
    return null;
  }

  return (
    <span className={className} aria-label={label}>
      {count > 99 ? "99+" : count}
    </span>
  );
}
