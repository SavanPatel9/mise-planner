import type { AuthErrorFlag } from "@mise/shared";
import { useEffect, useRef, useState } from "react";

import { useAuth, type SignedOutNotice } from "../auth/authContext";
import { takeAuthError } from "../auth/authError";

const AUTH_ERROR_COPY: Record<AuthErrorFlag, string> = {
  not_allowed:
    "This account isn't on the allowlist. Sign in with the Google account Mise was set up for.",
  failed: "Sign-in didn't finish. Please try again.",
};

const NOTICE_COPY: Record<SignedOutNotice, string> = {
  // No duration promised: the API's limiter counts in a fixed ten-minute
  // window, so the wait depends on where in that window the attempt landed.
  rate_limited: "Too many sign-in attempts. Please wait a bit, then try again.",
  unavailable: "Something went wrong reaching Mise. Please try again.",
};

export function SignIn() {
  const { state } = useAuth();
  const [authError, setAuthError] = useState<AuthErrorFlag | null>(null);
  const consumed = useRef(false);

  useEffect(() => {
    // StrictMode runs mount effects twice and the flag is gone after the first
    // pass, so an unguarded second read would blank the message it just set.
    if (consumed.current) {
      return;
    }

    consumed.current = true;
    setAuthError(takeAuthError());
  }, []);

  const notice = state.status === "signedOut" ? state.notice : undefined;
  // A notice wins over the redirect flag: it reports what `/api/me` just did
  // (429, or unreachable), whereas the flag can be stale or forced — an
  // allowlisted user sent to `/?authError=not_allowed` while `/api/me` is
  // failing must not be told they are off the allowlist. The flag is consumed
  // and stripped by the effect above either way, so it never resurfaces.
  const message =
    notice !== undefined
      ? NOTICE_COPY[notice]
      : authError !== null
        ? AUTH_ERROR_COPY[authError]
        : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-3xl font-semibold text-slate-900">Mise</h1>
        <p className="mt-2 text-sm text-slate-600">
          Everything in its place before your day begins.
        </p>

        {/* Rendered unconditionally so the live region exists before it has
            anything to announce. */}
        <div role="status">
          {message !== null ? (
            <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {message}
            </p>
          ) : null}
        </div>

        {/* A real link, not a button: sign-in is a top-level navigation to the
            API, which then redirects to Google. */}
        <a
          href="/api/auth/google"
          className="mt-6 block w-full rounded-md bg-slate-900 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        >
          Sign in with Google
        </a>
      </div>
    </main>
  );
}
