// Who may sign in at all. `ALLOWED_EMAILS` is a comma-separated list, and an
// address absent from it is rejected before any database write.
//
// Fail-safe by construction: an unset, empty, or all-blank list yields an empty
// set, which allows nobody. A misconfigured deploy locks the owner out rather
// than opening the app to every Google account.
//
// Nothing here logs or interpolates an address or the env value.
const ALLOWLIST_VAR = "ALLOWED_EMAILS";

/**
 * Lowercases and trims. Technically the local part of an address is
 * case-sensitive, but Gmail is not and the allowlist is hand-written, so
 * comparing case-insensitively is what a human expects from it.
 */
function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Re-read on every call rather than cached at module load: the var is read
 * once per sign-in (not a hot path), and caching would make the value depend
 * on import order.
 */
function loadAllowlist(): Set<string> {
  const raw = process.env[ALLOWLIST_VAR];
  if (typeof raw !== "string") {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map(normalize)
      .filter((entry) => entry !== ""),
  );
}

/** True only for a non-empty address present in a non-empty allowlist. */
export function isAllowed(email: string): boolean {
  if (typeof email !== "string") {
    return false;
  }

  const candidate = normalize(email);
  if (candidate === "") {
    return false;
  }

  return loadAllowlist().has(candidate);
}
