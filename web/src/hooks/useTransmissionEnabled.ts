// Feature gate for the admin Downloads tab. The server only mounts the
// Transmission admin router when TRANSMISSION_URL is configured, so the tab
// reads the matching public flag before it offers that route.
//
// api/config.ts caches and deduplicates the underlying request. Multiple
// callers still cost one probe per page load.

import { useEffect, useState } from "react";
import { fetchPublicConfig } from "../api/config";

/**
 * `null` while the probe is in flight, then whether Transmission is configured.
 *
 * The config probe never rejects; failures settle to false so the UI does not
 * advertise an unmounted route.
 */
export function useTransmissionEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPublicConfig().then((config) => {
      if (!cancelled) {
        setEnabled(config.transmissionEnabled);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return enabled;
}
