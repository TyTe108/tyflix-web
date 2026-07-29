// One feature flag, read from /api/config. Self-serve access requests only
// exist when ACCESS_REQUESTS_FILE is configured on the server, and the routes
// aren't even mounted otherwise, so the UI has to ask before it offers a link
// to /request-access.
//
// The underlying fetch is cached and deduped in api/config.ts, so every
// component that calls this hook shares a single probe per page load. Calling
// it in several places costs nothing.

import { useEffect, useState } from "react";
import { fetchPublicConfig } from "../api/config";

/**
 * `null` while the probe is in flight — callers must render nothing in gated
 * slots until a boolean is known (avoids a flash of dead links).
 *
 * Never rejects and never leaves you waiting forever: the probe fails closed to
 * false, so an unreachable server settles on "feature off" rather than sitting
 * at null.
 */
export function useAccessRequestsEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  // Runs once. The cancelled flag is only there to stop a late resolution from
  // setting state on an unmounted component, which StrictMode's double-mount
  // makes easy to hit in development.
  useEffect(() => {
    let cancelled = false;
    void fetchPublicConfig().then((config) => {
      if (!cancelled) {
        setEnabled(config.accessRequestsEnabled);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return enabled;
}
