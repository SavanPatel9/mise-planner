import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError, apiFetch } from "./api/client";
import { App } from "./App";

const USER = { id: "user-cuid-m2t7", email: "chef@example.com", name: "Chef" };

const ME = "/api/me";
const LOGOUT = "/api/auth/logout";

const fetchMock = vi.fn<typeof fetch>();

/** A handler per `/api/...` path; anything unrouted is a test bug, not a 404. */
type Routes = Record<string, () => Promise<Response>>;

function route(routes: Routes): void {
  fetchMock.mockImplementation((input) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const handler = routes[path];
    if (handler === undefined) {
      return Promise.reject(new Error(`unrouted fetch: ${path}`));
    }

    return handler();
  });
}

function json(status: number, body: unknown): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

const ok = (body: unknown) => json(200, body);
const noContent = () => Promise.resolve(new Response(null, { status: 204 }));
const unauthorized = json(401, { error: "Unauthorized" });

/** A request that never reaches the server: what `fetch` itself rejects with. */
const offline = (): Promise<Response> =>
  Promise.reject(new TypeError("Failed to fetch"));

/** Note the typographic apostrophe: `&rsquo;` is what renders in the shell. */
const SIGN_OUT_FAILED = "Couldn’t sign out. Try again in a moment.";

/** Lets a test hold `/api/me` in flight and assert the loading state. */
function deferred(): {
  promise: Promise<Response>;
  resolve: (value: Response) => void;
} {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

const signInLink = () =>
  screen.findByRole("link", { name: /sign in with google/i });

const signOutButton = () => screen.getByRole("button", { name: /sign out/i });

/**
 * Stripping `?authError=` happens in a mount effect and changes no DOM, so a
 * query that resolved on the render before React flushed passive effects can
 * still see the flag. Polled rather than read once, or the assertion races.
 */
const expectSearch = (search: string) =>
  waitFor(() => {
    expect(window.location.search).toBe(search);
  });

/** Every `POST /api/auth/logout` this test issued, in order. */
const logoutCalls = () =>
  fetchMock.mock.calls.filter(([input]) => String(input) === LOGOUT);

/**
 * The shell is still mounted with the session's user on it and sign-in is
 * nowhere on screen: the session was not claimed destroyed.
 */
function expectStillSignedIn(): void {
  expect(screen.getByText("Chef · chef@example.com")).toBeInTheDocument();
  expect(signOutButton()).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: /sign in with google/i }),
  ).not.toBeInTheDocument();
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("App auth gate", () => {
  it("shows the loading state until /api/me answers, then the app shell", async () => {
    const me = deferred();
    route({ [ME]: () => me.promise });

    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent(/loading mise/i);
    expect(
      screen.queryByRole("button", { name: /sign out/i }),
    ).not.toBeInTheDocument();

    await act(async () => {
      me.resolve(
        new Response(JSON.stringify(USER), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await me.promise;
    });

    expect(
      await screen.findByText("Chef · chef@example.com"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign out/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/loading mise/i)).not.toBeInTheDocument();
  });

  it("shows only the email when the account has no name", async () => {
    route({ [ME]: ok({ ...USER, name: null }) });

    render(<App />);

    expect(await screen.findByText("chef@example.com")).toBeInTheDocument();
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
  });

  it("renders sign-in when /api/me returns 401", async () => {
    route({ [ME]: unauthorized });

    render(<App />);

    expect(await signInLink()).toHaveAttribute("href", "/api/auth/google");
    // A missing session is the ordinary case: nothing to warn about.
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("explains a rate-limited sign-in when /api/me returns 429", async () => {
    route({ [ME]: json(429, { error: "Too many requests" }) });

    render(<App />);

    expect(
      await screen.findByText(/too many sign-in attempts/i),
    ).toBeInTheDocument();
    expect(await signInLink()).toBeInTheDocument();
  });

  it("falls back to one generic notice when /api/me fails otherwise", async () => {
    route({ [ME]: json(500, { error: "Internal error" }) });

    render(<App />);

    expect(
      await screen.findByText(/something went wrong reaching mise/i),
    ).toBeInTheDocument();
  });

  it("uses the same generic notice when the request never lands", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    render(<App />);

    expect(
      await screen.findByText(/something went wrong reaching mise/i),
    ).toBeInTheDocument();
  });
});

describe("App ?authError= handling", () => {
  it("shows the allowlist copy and strips the param (StrictMode)", async () => {
    window.history.replaceState(null, "", "/?authError=not_allowed");
    route({ [ME]: unauthorized });

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(
      await screen.findByText(/isn't on the allowlist/i),
    ).toBeInTheDocument();
    expect(window.location.search).toBe("");
    // The double mount must not blank the message it just read.
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/allowlist/i);
    });
  });

  it("shows the generic failure copy for ?authError=failed", async () => {
    window.history.replaceState(null, "", "/?authError=failed");
    route({ [ME]: unauthorized });

    render(<App />);

    expect(
      await screen.findByText(/sign-in didn't finish/i),
    ).toBeInTheDocument();
  });

  it("renders no error copy for an unrecognised flag value", async () => {
    window.history.replaceState(null, "", "/?authError=totally-made-up");
    route({ [ME]: unauthorized });

    render(<App />);

    expect(await signInLink()).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    await expectSearch("");
  });

  it("prefers the /api/me notice over the redirect flag", async () => {
    window.history.replaceState(null, "", "/?authError=not_allowed");
    route({ [ME]: json(429, { error: "Too many requests" }) });

    render(<App />);

    // An allowlisted user forced to ?authError=not_allowed while /api/me 429s
    // must be told about the rate limit, not falsely denied.
    expect(
      await screen.findByText(/too many sign-in attempts/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/isn't on the allowlist/i),
    ).not.toBeInTheDocument();
    // The flag is still consumed, so it cannot resurface on a later render.
    await expectSearch("");
  });

  it("prefers the generic notice over the redirect flag too", async () => {
    window.history.replaceState(null, "", "/?authError=failed");
    route({ [ME]: json(500, { error: "Internal error" }) });

    render(<App />);

    expect(
      await screen.findByText(/something went wrong reaching mise/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/sign-in didn't finish/i),
    ).not.toBeInTheDocument();
    await expectSearch("");
  });

  it("never shows failure copy to a signed-in user carrying the flag", async () => {
    window.history.replaceState(null, "", "/?authError=not_allowed&view=today");
    route({ [ME]: ok(USER) });

    render(<App />);

    expect(
      await screen.findByText("Chef · chef@example.com"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/allowlist/i)).not.toBeInTheDocument();
    await expectSearch("?view=today");
  });
});

describe("App sign-out", () => {
  it("posts to /api/auth/logout and returns to sign-in", async () => {
    route({ [ME]: ok(USER), [LOGOUT]: noContent });

    render(<App />);
    const button = await screen.findByRole("button", { name: /sign out/i });
    fireEvent.click(button);

    expect(await signInLink()).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      LOGOUT,
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("stays signed in and offers a retry when logout 500s", async () => {
    route({ [ME]: ok(USER), [LOGOUT]: json(500, { error: "Internal error" }) });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /sign out/i }));

    // A 500 is `req.logout()`'s callback erroring: the session may have
    // survived, so the only honest answer is "that didn't work, try again".
    expect(await screen.findByRole("status")).toHaveTextContent(
      SIGN_OUT_FAILED,
    );
    expectStillSignedIn();
    // The flag has to be released or the retry it just offered is unclickable.
    expect(signOutButton()).toBeEnabled();
  });

  it("stays signed in when the auth limiter refuses logout with a 429", async () => {
    route({
      [ME]: ok(USER),
      [LOGOUT]: json(429, { error: "Too many requests" }),
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /sign out/i }));

    // The limiter answers before the route runs, so nothing touched the
    // session: reading this as a successful sign-out would strand a live
    // session behind a sign-in screen.
    expect(await screen.findByRole("status")).toHaveTextContent(
      SIGN_OUT_FAILED,
    );
    expectStillSignedIn();
    expect(signOutButton()).toBeEnabled();
  });

  it("lands on sign-in when logout 401s because the session is already gone", async () => {
    route({ [ME]: ok(USER), [LOGOUT]: unauthorized });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /sign out/i }));

    // A 401 proves there is no session left to destroy. The client's global
    // 401 handler also fires on this response; both paths agree on signedOut,
    // so the end state is sign-in with no retry copy and no stray notice.
    expect(await signInLink()).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByText(SIGN_OUT_FAILED)).not.toBeInTheDocument();
    expect(logoutCalls()).toHaveLength(1);
  });

  it("lands on sign-in when logout 403s", async () => {
    route({ [ME]: ok(USER), [LOGOUT]: json(403, { error: "Forbidden" }) });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /sign out/i }));

    // Unlike a 401, nothing in the client's global handling reacts to a 403, so
    // this pins sign-out's own "nothing left to destroy" branch.
    expect(await signInLink()).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("disables the button in flight so a second click spends no extra request", async () => {
    const logout = deferred();
    route({ [ME]: ok(USER), [LOGOUT]: () => logout.promise });

    render(<App />);
    const button = await screen.findByRole("button", { name: /sign out/i });
    fireEvent.click(button);

    expect(button).toBeDisabled();
    // An impatient second click must not spend another of the auth rate
    // limiter's tokens on the same sign-out.
    fireEvent.click(button);
    expect(logoutCalls()).toHaveLength(1);

    await act(async () => {
      logout.resolve(new Response(null, { status: 204 }));
      await logout.promise;
    });

    expect(await signInLink()).toBeInTheDocument();
    expect(logoutCalls()).toHaveLength(1);
  });

  it("stays signed in and offers a retry when logout never reaches the server", async () => {
    route({ [ME]: ok(USER), [LOGOUT]: offline });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /sign out/i }));

    // The request was attempted and rejected at the network level, so the
    // cookie and its server session are both still live: showing sign-in here
    // would claim a session was destroyed that a reload would restore.
    expect(await screen.findByRole("status")).toHaveTextContent(
      SIGN_OUT_FAILED,
    );
    expect(screen.getByText("Chef · chef@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign out/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /sign in with google/i }),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      LOGOUT,
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("clears the retry copy on the next attempt and signs out when it lands", async () => {
    route({ [ME]: ok(USER), [LOGOUT]: offline });

    render(<App />);
    const button = await screen.findByRole("button", { name: /sign out/i });
    fireEvent.click(button);
    expect(await screen.findByText(SIGN_OUT_FAILED)).toBeInTheDocument();

    // Held in flight: the stale warning must go the moment the retry starts,
    // not only once it answers, or it reads as a failure of this attempt.
    const retry = deferred();
    route({ [ME]: ok(USER), [LOGOUT]: () => retry.promise });
    fireEvent.click(button);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    await act(async () => {
      retry.resolve(new Response(null, { status: 204 }));
      await retry.promise;
    });

    expect(await signInLink()).toBeInTheDocument();
    expect(screen.queryByText(SIGN_OUT_FAILED)).not.toBeInTheDocument();
  });
});

describe("App mid-session expiry", () => {
  it("returns to sign-in when any later request 401s", async () => {
    route({ [ME]: ok(USER), "/api/tasks": unauthorized });

    render(<App />);
    expect(
      await screen.findByText("Chef · chef@example.com"),
    ).toBeInTheDocument();

    await act(async () => {
      await expect(apiFetch("/tasks")).rejects.toBeInstanceOf(ApiRequestError);
    });

    expect(await signInLink()).toBeInTheDocument();
    // An expired cookie is not a failed sign-in attempt: no warning copy.
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});
