// Input-modality branch for player gestures (double-tap skip, tap-to-reveal).
// Exists separately from useIsMobile because one asks about layout
// (viewport width) and the other about input modality (primary pointer), and
// a landscape phone is where those two answers diverge — ~851 CSS px wide, so
// the width query is false while the device is still touch.
import { useEffect, useState } from "react";

/**
 * Primary-pointer coarse query. Orientation-independent, unlike the layout
 * breakpoint in {@link useIsMobile}.
 */
export const TOUCH_MEDIA_QUERY = "(pointer: coarse)";

/**
 * True when the primary pointer matches {@link TOUCH_MEDIA_QUERY}.
 *
 * @throws Error when `window.matchMedia` is missing. The check runs inside the
 * hook (not at module load) so a missing polyfill fails at the call site with
 * a clear signal instead of depending on import order relative to test setup.
 * Returning false instead would silently serve phones the desktop gesture path.
 */
export function useIsTouch(): boolean {
  if (typeof window.matchMedia !== "function") {
    throw new Error(
      "window.matchMedia is unavailable; cannot resolve the touch pointer query",
    );
  }

  const [isTouch, setIsTouch] = useState(
    () => window.matchMedia(TOUCH_MEDIA_QUERY).matches,
  );

  useEffect(() => {
    const mediaQueryList = window.matchMedia(TOUCH_MEDIA_QUERY);
    const onChange = () => {
      setIsTouch(mediaQueryList.matches);
    };

    mediaQueryList.addEventListener("change", onChange);
    setIsTouch(mediaQueryList.matches);

    return () => {
      mediaQueryList.removeEventListener("change", onChange);
    };
  }, []);

  return isTouch;
}
