// Viewport branch for the authenticated chrome. AppShell reads this to choose
// between the desktop sidebar and MobileNav; the matching CSS lives in
// styles.css under the same media query.
import { useEffect, useState } from "react";

/**
 * Shared with the mobile chrome block in styles.css — keep the two identical
 * so the JS mount branch and the CSS layout can never drift apart.
 */
export const MOBILE_MEDIA_QUERY = "(max-width: 48rem)";

/**
 * True when the viewport matches {@link MOBILE_MEDIA_QUERY}.
 *
 * @throws Error when `window.matchMedia` is missing. The check runs inside the
 * hook (not at module load) so a missing polyfill fails at the call site with
 * a clear signal instead of depending on import order relative to test setup.
 * Returning false instead would silently serve phones the desktop layout.
 */
export function useIsMobile(): boolean {
  if (typeof window.matchMedia !== "function") {
    throw new Error(
      "window.matchMedia is unavailable; cannot resolve the mobile breakpoint",
    );
  }

  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(MOBILE_MEDIA_QUERY).matches,
  );

  useEffect(() => {
    const mediaQueryList = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = () => {
      setIsMobile(mediaQueryList.matches);
    };

    mediaQueryList.addEventListener("change", onChange);
    setIsMobile(mediaQueryList.matches);

    return () => {
      mediaQueryList.removeEventListener("change", onChange);
    };
  }, []);

  return isMobile;
}
