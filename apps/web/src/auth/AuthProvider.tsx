// Who the user is, resolved from `GET /api/me` on load. The server's session
// cookie is the only source of truth — nothing auth-related is ever written to
// localStorage, so there is no stale "signed in" to contradict it.
import type { MeResponse } from "@mise/shared";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  ApiRequestError,
  apiFetch,
  setUnauthorizedHandler,
} from "../api/client";
import {
  AuthContext,
  type AuthContextValue,
  type AuthState,
  type SignedOutNotice,
} from "./authContext";

/**
 * A `401` is the expected answer for "not signed in" and needs no notice; a
 * `429` is the auth rate limiter, which the user can only wait out. Everything
 * else — network failure, a 500, an unparseable body — is one generic notice:
 * the cause is not the user's to distinguish.
 */
function noticeFor(error: unknown): SignedOutNotice | undefined {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) {
      return undefined;
    }

    if (error.status === 429) {
      return "rate_limited";
    }
  }

  return "unavailable";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const user = await apiFetch<MeResponse>("/me");
        if (active) {
          setState({ status: "signedIn", user });
        }
      } catch (error) {
        if (active) {
          setState({ status: "signedOut", notice: noticeFor(error) });
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const handleUnauthorized = useCallback(() => {
    // Already signed out: keep whatever notice is on screen, since a `401`
    // tells that user nothing they are not already being told.
    setState((current) =>
      current.status === "signedOut" ? current : { status: "signedOut" },
    );
  }, []);

  useEffect(() => {
    // The teardown returned by the setter clears the slot only while this
    // function is still the registered one, which is what makes StrictMode's
    // mount/cleanup/mount sequence safe.
    return setUnauthorizedHandler(handleUnauthorized);
  }, [handleUnauthorized]);

  const signOut = useCallback(async () => {
    try {
      await apiFetch<void>("/auth/logout", { method: "POST" });
    } catch (error) {
      // Clear to "signed out" only on an answer that proves the session is
      // gone: a success, or a `401`/`403`, where there was nothing to destroy.
      // Every other outcome leaves it plausibly alive — a `429` is the auth
      // rate limiter refusing the request before the route runs, a `5xx` means
      // `req.logout()`'s callback errored and the session may have survived,
      // and anything that is not an `ApiRequestError` never reached the server
      // (offline, DNS). Claiming signed-out there would tell the next person
      // at this machine the session is gone when a reload would restore it.
      if (
        !(error instanceof ApiRequestError) ||
        (error.status !== 401 && error.status !== 403)
      ) {
        return false;
      }
    }

    setState({ status: "signedOut" });
    return true;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ state, signOut }),
    [state, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
