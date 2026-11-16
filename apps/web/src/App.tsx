import type { MeResponse } from "@mise/shared";
import { useEffect, useRef, useState } from "react";

import { AuthProvider } from "./auth/AuthProvider";
import { useAuth } from "./auth/authContext";
import { stripAuthErrorParam } from "./auth/authError";
import { Settings } from "./pages/Settings";
import { SignIn } from "./pages/SignIn";
import { Tasks } from "./pages/Tasks";
import { useDetectedTimezone } from "./settings/useDetectedTimezone";

export function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

/** The three states of `GET /api/me`, and nothing else. */
function AuthGate() {
  const { state, signOut } = useAuth();

  if (state.status === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <div role="status" className="flex items-center gap-3">
          <span
            aria-hidden="true"
            // `motion-reduce:animate-none` leaves the ring itself visible, so
            // the indicator still reads as "busy" without the rotation.
            className="size-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700 motion-reduce:animate-none"
          />
          <span className="sr-only">Loading Mise…</span>
        </div>
      </main>
    );
  }

  if (state.status === "signedOut") {
    return <SignIn />;
  }

  return <AppShell user={state.user} onSignOut={signOut} />;
}

/** Which screen the shell is showing. No router: there are two of them. */
type View = "today" | "settings";

const VIEW_LABELS: Record<View, string> = {
  today: "Today",
  settings: "Settings",
};

function AppShell({
  user,
  onSignOut,
}: {
  user: MeResponse;
  onSignOut: () => Promise<boolean>;
}) {
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [signOutPending, setSignOutPending] = useState(false);
  const [view, setView] = useState<View>("today");
  const mainRef = useRef<HTMLElement>(null);
  const shownView = useRef<View | null>(null);

  // Runs here rather than in `AuthProvider`: it is signed-in work, and the
  // provider also renders the sign-in screen.
  useDetectedTimezone();

  useEffect(() => {
    // Focus follows the view so the change is perceivable without sight — the
    // landmark's name is read on arrival. Skipped unless the view actually
    // changed, which also keeps StrictMode's second mount pass from pulling
    // focus out of the page on load.
    const previous = shownView.current;
    shownView.current = view;

    if (previous !== null && previous !== view) {
      mainRef.current?.focus();
    }
  }, [view]);

  useEffect(() => {
    // A forced callback can land a signed-in user here with `?authError=`
    // still attached; drop it so a later render can never show that user
    // sign-in-failure copy.
    stripAuthErrorParam();
  }, []);

  const handleSignOut = () => {
    setSignOutFailed(false);
    // Held for the whole request so a retry-happy click can't spend several of
    // the auth rate limiter's tokens on one sign-out.
    setSignOutPending(true);
    // Only the failing branch sets state — including releasing the flag: a
    // sign-out that lands unmounts this component, so there is nothing left
    // here to report success to.
    void onSignOut().then((signedOut) => {
      if (!signedOut) {
        setSignOutPending(false);
        setSignOutFailed(true);
      }
    });
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4">
        {/* `min-w-0` lets this flex child shrink below its content width so a
            long name or email truncates instead of squeezing the button. */}
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-slate-900">Mise</h1>
          <p className="truncate text-sm text-slate-600">
            {user.name !== null ? `${user.name} · ` : null}
            {user.email}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setView((current) =>
                current === "settings" ? "today" : "settings",
              );
            }}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          >
            {view === "settings" ? "Back to today" : "Settings"}
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signOutPending}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Rendered unconditionally so the live region exists before it has
          anything to announce. Sits under the header, within sight of the
          button that failed. */}
      <div role="status">
        {signOutFailed ? (
          <p className="border-b border-amber-300 bg-amber-50 px-6 py-3 text-sm text-amber-900">
            Couldn&rsquo;t sign out. Try again in a moment.
          </p>
        ) : null}
      </div>

      {/* Named after the current view and focusable so switching screens can
          move focus here; the outline is left to the browser rather than
          suppressed, which keeps the landing point visible. */}
      <main
        ref={mainRef}
        tabIndex={-1}
        aria-label={VIEW_LABELS[view]}
        className="px-6 py-10"
      >
        {view === "settings" ? <Settings /> : <Tasks />}
      </main>
    </div>
  );
}
