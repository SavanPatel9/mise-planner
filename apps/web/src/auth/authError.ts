// The `?authError=` flag the API's sign-in callback redirects with, read off
// the URL exactly once. Type-only import: `@mise/shared` has no build output,
// so a runtime value import from here would not resolve.
import type { AuthErrorFlag } from "@mise/shared";

const AUTH_ERROR_PARAM = "authError";

// `satisfies` rather than an annotation: it keeps the literal element types
// and rejects typos/stale entries. It does NOT force this list to grow when
// the shared union gains a flag — the `Record<AuthErrorFlag, string>` copy map
// in SignIn.tsx is the exhaustiveness gate; update this list alongside it.
const AUTH_ERROR_FLAGS = [
  "not_allowed",
  "failed",
] as const satisfies readonly AuthErrorFlag[];

function isAuthErrorFlag(value: string): value is AuthErrorFlag {
  return (AUTH_ERROR_FLAGS as readonly string[]).includes(value);
}

/**
 * Drops `?authError=` from the address bar without a reload, leaving the rest
 * of the URL untouched. Idempotent, so the signed-in path can call it blindly:
 * a forced callback can land an already-signed-in user here with a flag
 * attached, and that user must never be shown sign-in-failure copy.
 */
export function stripAuthErrorParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(AUTH_ERROR_PARAM)) {
    return;
  }

  url.searchParams.delete(AUTH_ERROR_PARAM);
  // Pass the parsed absolute URL, not a reassembled relative string: a path
  // beginning with `//` would resolve scheme-relative to another origin and
  // make replaceState throw a SecurityError mid-mount. `url` came from
  // window.location.href, so its origin is ours by construction.
  window.history.replaceState(window.history.state, "", url.toString());
}

/**
 * Reads the flag and strips it, so a reload or a later navigation does not
 * resurrect the message. Only the two flags the API actually sends are
 * recognised — anything else (a hand-typed value, a crafted link) is `null`
 * rather than generic failure copy, which keeps the UI from asserting a failed
 * sign-in that never happened.
 */
export function takeAuthError(): AuthErrorFlag | null {
  const raw = new URLSearchParams(window.location.search).get(AUTH_ERROR_PARAM);
  stripAuthErrorParam();

  return raw !== null && isAuthErrorFlag(raw) ? raw : null;
}
