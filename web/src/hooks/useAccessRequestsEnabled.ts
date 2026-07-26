import { useEffect, useState } from "react";
import { fetchPublicConfig } from "../api/config";

/**
 * `null` while the probe is in flight — callers must render nothing in gated
 * slots until a boolean is known (avoids a flash of dead links).
 */
export function useAccessRequestsEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);

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
