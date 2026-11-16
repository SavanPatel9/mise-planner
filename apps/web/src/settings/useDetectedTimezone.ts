// Fills in the stored timezone from the browser, once per sign-in, and only
// while the user has not chosen one themselves. Mounted inside the signed-in
// subtree so it never runs for a visitor who has no settings to read.
import { useEffect, useRef } from "react";

import { getSettings, submitDetectedTimezone } from "../api/settings";

export function useDetectedTimezone(): void {
  const started = useRef(false);

  useEffect(() => {
    // StrictMode runs a mount effect twice; the write below must be attempted
    // at most once for this mount, or the second pass races the first.
    if (started.current) {
      return;
    }

    started.current = true;

    void (async () => {
      try {
        const settings = await getSettings();
        const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;

        // Three reasons not to bother the server, none of them the guard that
        // matters: `/settings/detected` enforces the `DETECTED` condition in
        // its own statement, so an explicit choice is safe from this hook even
        // if the read above were stale. This is only about not spending a
        // request on a write that would change nothing.
        if (
          settings.timezoneSource !== "DETECTED" ||
          detected === settings.timezone ||
          !detected
        ) {
          return;
        }

        // Never the explicit endpoint: that one would record the browser's
        // guess as the user's choice and stop detection for good — a
        // travelling user's zone would freeze at wherever they first signed in.
        await submitDetectedTimezone({ timezone: detected });
      } catch {
        // Bookkeeping, not the user's errand: nothing was promised on screen,
        // the stored zone stays as it is, and the next sign-in tries again.
        // Settings is where a wrong zone gets corrected.
      }
    })();
  }, []);
}
