// The auth context and its hook live apart from `AuthProvider.tsx` so that
// file exports a component and nothing else — `react-refresh` errors otherwise
// (fast refresh gives up on a module that mixes the two).
import type { MeResponse } from "@mise/shared";
import { createContext, useContext } from "react";

/**
 * Why the sign-in screen is showing when the user did not ask for it. Absent
 * for the ordinary case (no session), set when `/api/me` failed for a reason
 * the user can act on.
 */
export type SignedOutNotice = "rate_limited" | "unavailable";

export type AuthState =
  | { status: "loading" }
  | { status: "signedIn"; user: MeResponse }
  | { status: "signedOut"; notice?: SignedOutNotice };

export interface AuthContextValue {
  state: AuthState;
  /**
   * Resolves `true` once the local state is cleared, `false` when the logout
   * request never reached the server — the cookie and its server session are
   * then both still live, so the caller stays signed in and offers a retry.
   */
  signOut: () => Promise<boolean>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }

  return value;
}
