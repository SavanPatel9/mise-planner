import session from "express-session";
import { inspect } from "node:util";
import passport from "passport";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prisma is mocked at the module boundary: `deserializeUser` is the only
// database call an authenticated request makes, and no test here may open a
// connection. The spies live outside the factory (`vi.hoisted`) so the suite
// can re-arm them per test.
const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@mise/db", () => ({
  prisma: { user: { findUnique: db.findUnique, upsert: db.upsert } },
}));

import { createApp } from "../app.js";
import { configurePassport, VerifyFailure } from "../auth/passport.js";
import { SESSION_COOKIE_NAME } from "../auth/session.js";

// Fixtures only, and obviously fake. The token values are distinctive so a leak
// into a response body, a session row, or the console is unambiguous.
const WEB_ORIGIN = "http://localhost:5173";
const CALLBACK_URL = "http://localhost:3000/api/auth/google/callback";
const CLIENT_SECRET = "fake-client-secret-91ab";
const USER_ID = "user-cuid-m2t4";
const EMAIL = "chef@example.com";
const NAME = "Mise Chef";
const ACCESS_TOKEN = "fake-access-token-4c1d";
const REFRESH_TOKEN = "fake-refresh-token-8b7e";
const GRANTED_SCOPE = "openid email";

/** What the web app is sent back to once the redirect is built from the origin. */
const WEB_APP_URL = "http://localhost:5173/";

/** What `deserializeUser` reads back out of the database — never any token. */
const SESSION_USER = { id: USER_ID, email: EMAIL, name: NAME };

/**
 * What a completed verify hands Passport: the stored user plus the live Google
 * credentials. Present here so every assertion about `/api/me`, the session
 * store, and the console has something that must *not* escape.
 */
const VERIFIED_USER: Express.User = {
  ...SESSION_USER,
  google: {
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    scopes: GRANTED_SCOPE,
  },
};

const SECRET_VALUES = [ACCESS_TOKEN, REFRESH_TOKEN, EMAIL, CLIENT_SECRET];

/**
 * What a log-injection attempt would have to produce to succeed: a line that
 * reads like one of ours and names a token. Distinctive, so finding it at the
 * start of any logged line is unambiguous.
 */
const FORGED_LOG_LINE = "[api] unhandled error: token=fake-forged-token-3d9c";

/**
 * A provider `error_description` carrying CRLF. Google never sends one, but the
 * callback is a plain GET: any page can navigate the browser to it with these
 * query params, and the value lands in an `AuthorizationError`'s message. If
 * that message reaches the console unescaped, the attacker has written their
 * own log line.
 */
const LOG_INJECTION_DESCRIPTION = `authorization failed\r\n${FORGED_LOG_LINE}`;

/** How the test double is told to answer the callback leg. */
type StubOutcome =
  | { kind: "success" }
  /**
   * `fail(info, status)` with `info` passed through untouched, so a test can
   * hand the route either the branded `VerifyFailure` the real verify reports
   * or one of the look-alikes it must not trust — a plain `{ message }`, or the
   * bare string passport-oauth2 uses for a challenge.
   */
  | { kind: "fail"; info: unknown }
  | { kind: "error"; error: Error };

/** The per-request callbacks Passport grafts onto a strategy before calling it. */
interface StrategyCallbacks {
  success(user: Express.User): void;
  fail(challenge: unknown, status?: number): void;
  error(error: Error): void;
}

/** Only the internals these tests read; `MemoryStore` exposes no listing API. */
interface MemoryStoreInternals {
  sessions: Record<string, string | undefined>;
}

/** Set while a test double stands in for the Google strategy; see `afterEach`. */
let stubInstalled = false;

/**
 * Replaces the Google strategy with a double that answers immediately. Must be
 * called *after* `createApp`, which re-registers the real strategy by the same
 * name.
 */
function useStubStrategy(outcome: StubOutcome): void {
  const strategy = {
    name: "google",
    authenticate(this: StrategyCallbacks) {
      switch (outcome.kind) {
        case "success":
          this.success(VERIFIED_USER);
          return;
        case "fail":
          this.fail(outcome.info, 401);
          return;
        case "error":
          this.error(outcome.error);
      }
    },
  };

  passport.use(strategy as unknown as passport.Strategy);
  stubInstalled = true;
}

/**
 * Puts the real Google strategy back mid-test, so a leg that has to go through
 * genuine `state` verification can follow one driven by the double. Leaves the
 * singleton in the state `afterEach` would restore it to.
 */
function useRealStrategy(): void {
  passport.unuse("google");
  configurePassport();
  stubInstalled = false;
}

function buildApp(store: session.Store) {
  return createApp({ sessionStore: store });
}

/** Silences and records every console channel; `restoreAllMocks` undoes it. */
function spyOnConsole() {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
  };
}

type ConsoleSpies = ReturnType<typeof spyOnConsole>;

/**
 * One string per console call, rendered as it would reach the log. Strings are
 * taken verbatim — not `JSON.stringify`d — because an escaped `\n` would hide
 * exactly the newline these tests are looking for.
 */
function consoleWrites(spies: ConsoleSpies): string[] {
  return Object.values(spies).flatMap((spy) =>
    spy.mock.calls.map((call) =>
      call
        .map((entry) => (typeof entry === "string" ? entry : inspect(entry)))
        .join(" "),
    ),
  );
}

/** Every logged line across every call — a stack trace contributes many. */
function consoleLines(spies: ConsoleSpies): string[] {
  return consoleWrites(spies).flatMap((written) => written.split(/\r\n|\r|\n/));
}

function setCookieHeaders(response: {
  headers: Record<string, unknown>;
}): string[] {
  const raw = response.headers["set-cookie"];
  if (Array.isArray(raw)) {
    return raw as string[];
  }

  return typeof raw === "string" ? [raw] : [];
}

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const cookie = setCookieHeaders(response).find((value) =>
    value.startsWith(`${SESSION_COOKIE_NAME}=`),
  );
  expect(
    cookie,
    `expected a ${SESSION_COOKIE_NAME} Set-Cookie header`,
  ).toBeDefined();

  return cookie as string;
}

/** The `name=value` pair, ready to be sent straight back as a `Cookie` header. */
function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

/** The session id inside a signed `connect.sid` cookie (`s:<sid>.<signature>`). */
function sidFromCookie(setCookie: string): string {
  const raw = decodeURIComponent(
    cookiePair(setCookie).slice(`${SESSION_COOKIE_NAME}=`.length),
  );
  const sid = raw.replace(/^s:/, "").split(".")[0] ?? "";
  expect(sid, "expected a signed session id in the cookie").not.toBe("");

  return sid;
}

function storedSids(store: session.MemoryStore): string[] {
  return Object.keys((store as unknown as MemoryStoreInternals).sessions);
}

/** The ids of stored sessions that carry a logged-in user. */
function authenticatedSids(store: session.MemoryStore): string[] {
  return storedSids(store).filter((sid) => {
    const raw = (store as unknown as MemoryStoreInternals).sessions[sid];
    if (raw === undefined) {
      return false;
    }

    const parsed = JSON.parse(raw) as { passport?: { user?: unknown } };

    return parsed.passport?.user !== undefined;
  });
}

function storeContents(store: session.MemoryStore): string {
  return JSON.stringify((store as unknown as MemoryStoreInternals).sessions);
}

function expectClearsSessionCookie(response: {
  headers: Record<string, unknown>;
}): void {
  const cookie = sessionCookie(response);
  expect(cookie).toMatch(
    new RegExp(`^${SESSION_COOKIE_NAME.replace(".", "\\.")}=;`),
  );
  expect(cookie).toContain("Expires=Thu, 01 Jan 1970");
}

/**
 * The mirror of `expectClearsSessionCookie`: nothing in the response may tell
 * the browser to drop `connect.sid`. An untouched session sends no `Set-Cookie`
 * at all, so an absent header passes — only a clearing one fails.
 */
function expectKeepsSessionCookie(response: {
  headers: Record<string, unknown>;
}): void {
  for (const cookie of setCookieHeaders(response)) {
    if (!cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      continue;
    }

    expect(cookie, "the session cookie must not be cleared").not.toMatch(
      new RegExp(`^${SESSION_COOKIE_NAME.replace(".", "\\.")}=;`),
    );
    expect(cookie).not.toContain("Expires=Thu, 01 Jan 1970");
  }
}

/**
 * Runs the real sign-in leg so the session holds the OAuth state and verifier a
 * genuine callback would have to match, and reports the cookie and session id
 * the client is left holding.
 */
async function startSignIn(
  app: ReturnType<typeof createApp>,
  cookie?: string,
): Promise<{ cookie: string; sid: string }> {
  const pending = request(app).get("/api/auth/google");
  const response = await (cookie === undefined
    ? pending
    : pending.set("Cookie", cookie));
  expect(response.status).toBe(302);

  const setCookie = sessionCookie(response);

  return { cookie: cookiePair(setCookie), sid: sidFromCookie(setCookie) };
}

/**
 * Runs both legs with the success double and reports the cookie and session id
 * a signed-in client is left holding. The double stays installed; a caller that
 * needs genuine `state` verification on a later leg calls `useRealStrategy`.
 */
async function completeSignIn(
  app: ReturnType<typeof createApp>,
): Promise<{ cookie: string; sid: string }> {
  const preAuth = await startSignIn(app);

  useStubStrategy({ kind: "success" });
  const response = await request(app)
    .get("/api/auth/google/callback?code=fake-auth-code")
    .set("Cookie", preAuth.cookie);
  expect(response.status).toBe(302);
  expect(response.headers.location).toBe(WEB_APP_URL);

  const setCookie = sessionCookie(response);

  return { cookie: cookiePair(setCookie), sid: sidFromCookie(setCookie) };
}

describe("auth routes", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    vi.stubEnv("GOOGLE_CLIENT_ID", "fake-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("GOOGLE_CALLBACK_URL", CALLBACK_URL);
    vi.stubEnv("WEB_ORIGIN", WEB_ORIGIN);

    db.findUnique.mockReset();
    db.findUnique.mockResolvedValue(SESSION_USER);
    db.upsert.mockReset();
  });

  afterEach(() => {
    // The Passport singleton is shared, so the real strategy goes back before
    // the env stubs come off — a leaked double would silently authenticate
    // another suite's requests.
    if (stubInstalled) {
      passport.unuse("google");
      configurePassport();
      stubInstalled = false;
    }

    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("createAuthRouter configuration", () => {
    it("fails fast when WEB_ORIGIN is missing", () => {
      vi.stubEnv("WEB_ORIGIN", undefined);

      expect(() => buildApp(new session.MemoryStore())).toThrow(
        "Missing required env var: WEB_ORIGIN",
      );
    });

    it("fails fast when WEB_ORIGIN is not an http(s) URL", () => {
      vi.stubEnv("WEB_ORIGIN", "javascript:alert(1)");

      expect(() => buildApp(new session.MemoryStore())).toThrow(
        "WEB_ORIGIN must be an http(s) URL",
      );
    });
  });

  describe("GET /api/auth/google", () => {
    it("redirects to Google with state, PKCE, offline access and consent", async () => {
      const response = await request(buildApp(new session.MemoryStore())).get(
        "/api/auth/google",
      );

      expect(response.status).toBe(302);

      const location = new URL(String(response.headers.location));
      expect(`${location.origin}${location.pathname}`).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
      // Without `state` passport-oauth2 uses its NullStore, which verifies any
      // callback; without PKCE the code is not bound to this session.
      expect(location.searchParams.get("state")).toMatch(/\S/);
      expect(location.searchParams.get("code_challenge")).toMatch(/\S/);
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      // The pair that makes Google return a refresh token.
      expect(location.searchParams.get("access_type")).toBe("offline");
      expect(location.searchParams.get("prompt")).toBe("consent");
      expect(location.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
    });

    it("hands the client an unauthenticated session to hold the OAuth state", async () => {
      const store = new session.MemoryStore();
      const app = buildApp(store);

      const preAuth = await startSignIn(app);

      expect(storedSids(store)).toEqual([preAuth.sid]);
      expect(authenticatedSids(store)).toEqual([]);

      // `/api/me` must not treat a sign-in-in-progress session as logged in.
      const me = await request(app)
        .get("/api/me")
        .set("Cookie", preAuth.cookie);

      expect(me.status).toBe(401);
      expect(me.body).toEqual({ error: "Unauthorized" });
    });
  });

  describe("GET /api/auth/google/callback — success", () => {
    it("redirects to the web origin, regenerates the session, and drops the pre-auth row", async () => {
      const store = new session.MemoryStore();
      const app = buildApp(store);
      const preAuth = await startSignIn(app);

      useStubStrategy({ kind: "success" });
      const response = await request(app)
        .get("/api/auth/google/callback?code=fake-auth-code")
        .set("Cookie", preAuth.cookie);

      expect(response.status).toBe(302);
      // Exactly the origin: nothing request-derived may reach `Location`.
      expect(response.headers.location).toBe(WEB_APP_URL);

      const loggedInSid = sidFromCookie(sessionCookie(response));
      // Session fixation: the id an attacker could have planted before sign-in
      // must not be the one that ends up authenticated.
      expect(loggedInSid).not.toBe(preAuth.sid);
      expect(storedSids(store)).toEqual([loggedInSid]);
      expect(authenticatedSids(store)).toEqual([loggedInSid]);
    });

    it("keeps only the user id in the session store", async () => {
      const store = new session.MemoryStore();
      const app = buildApp(store);
      const preAuth = await startSignIn(app);

      useStubStrategy({ kind: "success" });
      const response = await request(app)
        .get("/api/auth/google/callback?code=fake-auth-code")
        .set("Cookie", preAuth.cookie);

      const sid = sidFromCookie(sessionCookie(response));
      const raw = (store as unknown as MemoryStoreInternals).sessions[sid];
      const parsed = JSON.parse(raw ?? "{}") as {
        passport?: { user?: unknown };
      };

      expect(parsed.passport?.user).toBe(USER_ID);
      for (const secret of SECRET_VALUES) {
        expect(storeContents(store)).not.toContain(secret);
      }
    });

    it("ignores any path or query in WEB_ORIGIN when redirecting", async () => {
      vi.stubEnv("WEB_ORIGIN", "http://localhost:5173/landing?ref=google");
      const app = buildApp(new session.MemoryStore());
      const preAuth = await startSignIn(app);

      useStubStrategy({ kind: "success" });
      const response = await request(app)
        .get("/api/auth/google/callback?code=fake-auth-code")
        .set("Cookie", preAuth.cookie);

      expect(response.headers.location).toBe(WEB_APP_URL);
    });
  });

  describe("GET /api/auth/google/callback — refusal", () => {
    it("flags a non-allowlisted account as not_allowed and leaves no session", async () => {
      const store = new session.MemoryStore();
      const app = buildApp(store);
      const preAuth = await startSignIn(app);

      // The branded failure the real verify reports — the only `info` the
      // route is allowed to read a reason out of.
      useStubStrategy({ kind: "fail", info: new VerifyFailure("not_allowed") });
      const response = await request(app)
        .get("/api/auth/google/callback?code=fake-auth-code")
        .set("Cookie", preAuth.cookie);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(
        `${WEB_APP_URL}?authError=not_allowed`,
      );
      expectClearsSessionCookie(response);
      // The refusal destroys the session that carried the OAuth state.
      expect(storedSids(store)).toEqual([]);

      const me = await request(app)
        .get("/api/me")
        .set("Cookie", preAuth.cookie);

      expect(me.status).toBe(401);
      expect(me.body).toEqual({ error: "Unauthorized" });
      expect(authenticatedSids(store)).toEqual([]);
    });

    it.each([
      {
        label: "an unverified address",
        outcome: {
          kind: "fail",
          info: new VerifyFailure("email_unverified"),
        } satisfies StubOutcome,
        reason: "email_unverified",
      },
      {
        label: "a profile with no address",
        outcome: {
          kind: "fail",
          info: new VerifyFailure("no_email"),
        } satisfies StubOutcome,
        reason: "no_email",
      },
      {
        label: "a bare-string challenge",
        outcome: {
          kind: "fail",
          info: "fake-oauth-challenge",
        } satisfies StubOutcome,
        reason: "fake-oauth-challenge",
      },
      {
        // The shape passport-oauth2 builds from `?error=access_denied` — not
        // the verify's own failure, however much it looks like it. Reading
        // `info.message` off it is exactly the forgeable path.
        label: "an unbranded look-alike claiming not_allowed",
        outcome: {
          kind: "fail",
          info: { message: "not_allowed" },
        } satisfies StubOutcome,
        reason: "not_allowed",
      },
    ])(
      "collapses $label to authError=failed without echoing the reason",
      async ({ outcome, reason }) => {
        const store = new session.MemoryStore();
        const app = buildApp(store);
        const preAuth = await startSignIn(app);

        useStubStrategy(outcome);
        const response = await request(app)
          .get("/api/auth/google/callback?code=fake-auth-code")
          .set("Cookie", preAuth.cookie);

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(
          `${WEB_APP_URL}?authError=failed`,
        );
        // Telling an unknown caller which refusal it hit helps it enumerate.
        expect(response.text).not.toContain(reason);
        expect(storedSids(store)).toEqual([]);

        const me = await request(app)
          .get("/api/me")
          .set("Cookie", preAuth.cookie);

        expect(me.status).toBe(401);
        expect(authenticatedSids(store)).toEqual([]);
      },
    );

    it("refuses a callback whose state was never stored", async () => {
      // The real strategy, no double: an unsolicited code must not be accepted.
      const store = new session.MemoryStore();

      const response = await request(buildApp(store)).get(
        "/api/auth/google/callback?code=fake-auth-code&state=forged-state",
      );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${WEB_APP_URL}?authError=failed`);
      expect(response.text).not.toContain("forged-state");
      expect(authenticatedSids(store)).toEqual([]);
    });

    it("500s rather than redirecting when the strategy errors", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const store = new session.MemoryStore();
      const app = buildApp(store);

      useStubStrategy({
        kind: "error",
        error: new Error("stub strategy failure"),
      });
      const response = await request(app).get(
        "/api/auth/google/callback?code=fake-auth-code",
      );

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal Server Error" });
      expect(response.headers.location).toBeUndefined();
      expect(authenticatedSids(store)).toEqual([]);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  // A refused callback from an *already signed-in* browser is a forced logout
  // waiting to happen: the callback is a plain GET, so any page can navigate to
  // it with a made-up `code` and `state`. The refusal path may therefore only
  // destroy the session and clear the cookie for a caller that has none.
  describe("GET /api/auth/google/callback — refusal while signed in", () => {
    it("keeps the signed-in session when a forged-state callback is refused", async () => {
      const store = new session.MemoryStore();
      const app = buildApp(store);
      const signedIn = await completeSignIn(app);

      // The real strategy, so the refusal comes from genuine `state`
      // verification — exactly what a cross-site navigation would hit.
      useRealStrategy();
      const response = await request(app)
        .get("/api/auth/google/callback?code=fake-auth-code&state=forged-state")
        .set("Cookie", signedIn.cookie);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${WEB_APP_URL}?authError=failed`);
      expect(response.text).not.toContain("forged-state");
      // Neither half of the logout: no clearing cookie, no vanished row.
      expectKeepsSessionCookie(response);
      expect(storedSids(store)).toEqual([signedIn.sid]);
      expect(authenticatedSids(store)).toEqual([signedIn.sid]);

      // The cookie the browser still holds must still sign requests in.
      const me = await request(app)
        .get("/api/me")
        .set("Cookie", signedIn.cookie);

      expect(me.status).toBe(200);
      expect(me.body).toEqual({ id: USER_ID, email: EMAIL, name: NAME });
    });

    it("keeps the signed-in session when the strategy refuses the account", async () => {
      const store = new session.MemoryStore();
      const app = buildApp(store);
      const signedIn = await completeSignIn(app);

      useStubStrategy({ kind: "fail", info: new VerifyFailure("not_allowed") });
      const response = await request(app)
        .get("/api/auth/google/callback?code=fake-auth-code")
        .set("Cookie", signedIn.cookie);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(
        `${WEB_APP_URL}?authError=not_allowed`,
      );
      expectKeepsSessionCookie(response);
      expect(storedSids(store)).toEqual([signedIn.sid]);
      expect(authenticatedSids(store)).toEqual([signedIn.sid]);

      const me = await request(app)
        .get("/api/me")
        .set("Cookie", signedIn.cookie);

      expect(me.status).toBe(200);
      expect(me.body).toEqual({ id: USER_ID, email: EMAIL, name: NAME });
    });

    it("keeps the session when a re-consent the user started is refused", async () => {
      const store = new session.MemoryStore();
      const app = buildApp(store);
      const signedIn = await completeSignIn(app);

      // A genuine retry: the signed-in session picks up fresh OAuth state (the
      // real strategy, since the double answers the start leg too), and the
      // callback that follows is refused. Still no logout — the user is left
      // signed in as whoever they already were.
      useRealStrategy();
      const reconsent = await startSignIn(app, signedIn.cookie);
      expect(reconsent.sid).toBe(signedIn.sid);

      useStubStrategy({
        kind: "fail",
        info: new VerifyFailure("email_unverified"),
      });
      const response = await request(app)
        .get("/api/auth/google/callback?code=fake-auth-code")
        .set("Cookie", signedIn.cookie);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${WEB_APP_URL}?authError=failed`);
      expectKeepsSessionCookie(response);
      expect(authenticatedSids(store)).toEqual([signedIn.sid]);

      const me = await request(app)
        .get("/api/me")
        .set("Cookie", signedIn.cookie);

      expect(me.status).toBe(200);
      expect(me.body).toEqual({ id: USER_ID, email: EMAIL, name: NAME });
    });
  });

  // Everything in here is driven by the *real* strategy and nothing but query
  // params, because that is all an attacker has: the callback is a plain GET,
  // so any page can navigate the browser to it with `error` and
  // `error_description` of its choosing. Both values reach passport-oauth2
  // before any of our code runs.
  describe("GET /api/auth/google/callback — provider-supplied error", () => {
    it.each([
      { label: "CRLF", description: LOG_INJECTION_DESCRIPTION },
      {
        // Bare CR, which plenty of log viewers break a line on just the same.
        label: "a bare CR",
        description: `authorization failed\r${FORGED_LOG_LINE}`,
      },
    ])(
      "lets an error_description carrying $label forge no log line",
      async ({ description }) => {
        const spies = spyOnConsole();
        const store = new session.MemoryStore();

        const response = await request(buildApp(store)).get(
          `/api/auth/google/callback?error=server_error&error_description=${encodeURIComponent(
            description,
          )}`,
        );

        // The fault itself is unchanged: a provider error is a 500 with the
        // generic envelope, never the description echoed back.
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: "Internal Server Error" });
        expect(response.text).not.toContain(FORGED_LOG_LINE);
        expect(authenticatedSids(store)).toEqual([]);

        // The invariant: no line in the log may be one the attacker wrote. A
        // sanitized description may still appear — escaped, inside one of our
        // lines; what must not exist is a *separate* line of their text. Our own
        // first line is `[api] unhandled error: <message/stack>`, so the fixture
        // forges one only if a line *starts* with it.
        const forged = consoleLines(spies).filter((line) =>
          line.trimStart().startsWith(FORGED_LOG_LINE),
        );
        expect(forged, "a forged log line reached the console").toEqual([]);

        // And the decoded line break must not survive inside a logged string
        // either, in whatever form the console renders it.
        for (const written of consoleWrites(spies)) {
          expect(written).not.toContain(description);
        }
      },
    );

    it.each([
      { label: "the bare flag", description: "not_allowed" },
      {
        label: "the verify failure shape",
        description: '{"message":"not_allowed"}',
      },
      {
        label: "a flag hidden behind a newline",
        description: `denied\r\nnot_allowed`,
      },
    ])(
      "cannot be talked into authError=not_allowed with $label",
      async ({ description }) => {
        const spies = spyOnConsole();
        const store = new session.MemoryStore();

        const response = await request(buildApp(store)).get(
          `/api/auth/google/callback?error=access_denied&error_description=${encodeURIComponent(
            description,
          )}`,
        );

        // The invariant, whatever the status: `not_allowed` is the web app's
        // "this account isn't on the allowlist" copy, and only a genuine
        // allowlist refusal may produce it.
        expect(String(response.headers.location ?? "")).not.toContain(
          "not_allowed",
        );
        expect(response.text).not.toContain("not_allowed");
        expect(authenticatedSids(store)).toEqual([]);

        // Which observable outcome the fix produces is passport's choice — a
        // provider error can arrive as fail info (a redirect) or as the `err`
        // argument (a 500). Pinned to what the code actually does so a later
        // change to that routing is visible.
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(
          `${WEB_APP_URL}?authError=failed`,
        );
        expect(storedSids(store)).toEqual([]);
        expect(consoleWrites(spies).join(" ")).not.toContain("not_allowed");
      },
    );

    it("keeps the signed-in session when the provider reports access_denied", async () => {
      const store = new session.MemoryStore();
      const app = buildApp(store);
      const signedIn = await completeSignIn(app);

      // Same forced-logout risk as a forged `state`: a refusal a page can
      // trigger must not undo a good sign-in.
      useRealStrategy();
      const response = await request(app)
        .get(
          "/api/auth/google/callback?error=access_denied&error_description=denied",
        )
        .set("Cookie", signedIn.cookie);

      expect(String(response.headers.location ?? "")).not.toContain(
        "not_allowed",
      );
      expectKeepsSessionCookie(response);
      expect(authenticatedSids(store)).toEqual([signedIn.sid]);

      const me = await request(app)
        .get("/api/me")
        .set("Cookie", signedIn.cookie);

      expect(me.status).toBe(200);
      expect(me.body).toEqual({ id: USER_ID, email: EMAIL, name: NAME });
    });
  });

  describe("GET /api/me", () => {
    it("answers 401 with the error envelope when unauthenticated", async () => {
      const response = await request(buildApp(new session.MemoryStore())).get(
        "/api/me",
      );

      expect(response.status).toBe(401);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expect(db.findUnique).not.toHaveBeenCalled();
    });

    it("returns exactly id, email and name for a signed-in user", async () => {
      const store = new session.MemoryStore();
      const app = buildApp(store);
      const preAuth = await startSignIn(app);

      useStubStrategy({ kind: "success" });
      const callback = await request(app)
        .get("/api/auth/google/callback?code=fake-auth-code")
        .set("Cookie", preAuth.cookie);
      const cookie = cookiePair(sessionCookie(callback));

      const response = await request(app).get("/api/me").set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ id: USER_ID, email: EMAIL, name: NAME });
      // Field by field in the route, so no `google`/token key may appear even
      // though `req.user` can carry one.
      expect(Object.keys(response.body as object).sort()).toEqual([
        "email",
        "id",
        "name",
      ]);
      expect(response.text).not.toContain("google");
      expect(response.text).not.toContain(ACCESS_TOKEN);
      expect(response.text).not.toContain(REFRESH_TOKEN);
      // Restored from the session's user id alone, scoped to that id.
      expect(db.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: USER_ID } }),
      );
    });

    it("omits any extra field the restored user carries", async () => {
      const store = new session.MemoryStore();
      const app = buildApp(store);
      const preAuth = await startSignIn(app);

      useStubStrategy({ kind: "success" });
      const callback = await request(app)
        .get("/api/auth/google/callback?code=fake-auth-code")
        .set("Cookie", preAuth.cookie);
      const cookie = cookiePair(sessionCookie(callback));

      // A widened `select` or a new column must not start appearing on the
      // wire: the route names its three fields rather than spreading.
      db.findUnique.mockResolvedValue({
        ...SESSION_USER,
        googleAccessToken: ACCESS_TOKEN,
        timezone: "America/New_York",
      });

      const response = await request(app).get("/api/me").set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ id: USER_ID, email: EMAIL, name: NAME });
      expect(response.text).not.toContain(ACCESS_TOKEN);
      expect(response.text).not.toContain("timezone");
    });

    it("answers 401 when the session's user no longer exists", async () => {
      const store = new session.MemoryStore();
      const app = buildApp(store);
      const preAuth = await startSignIn(app);

      useStubStrategy({ kind: "success" });
      const callback = await request(app)
        .get("/api/auth/google/callback?code=fake-auth-code")
        .set("Cookie", preAuth.cookie);
      const cookie = cookiePair(sessionCookie(callback));

      db.findUnique.mockResolvedValue(null);
      const response = await request(app).get("/api/me").set("Cookie", cookie);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
    });
  });

  describe("POST /api/auth/logout", () => {
    it("204s, clears the cookie, and invalidates the old session", async () => {
      const store = new session.MemoryStore();
      const app = buildApp(store);
      const preAuth = await startSignIn(app);

      useStubStrategy({ kind: "success" });
      const callback = await request(app)
        .get("/api/auth/google/callback?code=fake-auth-code")
        .set("Cookie", preAuth.cookie);
      const cookie = cookiePair(sessionCookie(callback));
      expect(authenticatedSids(store)).toHaveLength(1);

      const response = await request(app)
        .post("/api/auth/logout")
        .set("Cookie", cookie);

      expect(response.status).toBe(204);
      expectClearsSessionCookie(response);
      // `logout` regenerates, so the route destroys the fresh row too.
      expect(storedSids(store)).toEqual([]);

      const me = await request(app).get("/api/me").set("Cookie", cookie);

      expect(me.status).toBe(401);
      expect(me.body).toEqual({ error: "Unauthorized" });
    });

    it("204s an unauthenticated logout without leaving a session behind", async () => {
      const store = new session.MemoryStore();

      const response = await request(buildApp(store)).post("/api/auth/logout");

      expect(response.status).toBe(204);
      expect(response.text).toBe("");
      expect(storedSids(store)).toEqual([]);
    });

    it("is not reachable over GET", async () => {
      // A GET would let any page log the user out with an image tag.
      const response = await request(buildApp(new session.MemoryStore())).get(
        "/api/auth/logout",
      );

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Not Found" });
    });
  });

  describe("logging hygiene", () => {
    it("writes nothing identifying to the console across a whole sign-in", async () => {
      const spies = spyOnConsole();

      const store = new session.MemoryStore();
      const app = buildApp(store);
      const preAuth = await startSignIn(app);

      useStubStrategy({ kind: "success" });
      const callback = await request(app)
        .get("/api/auth/google/callback?code=fake-auth-code")
        .set("Cookie", preAuth.cookie);
      const cookie = cookiePair(sessionCookie(callback));
      await request(app).get("/api/me").set("Cookie", cookie);
      await request(app).post("/api/auth/logout").set("Cookie", cookie);

      // And a refusal, whose `info` is the one thing a redirect never carries.
      const refused = buildApp(new session.MemoryStore());
      const refusedPreAuth = await startSignIn(refused);
      useStubStrategy({ kind: "fail", info: new VerifyFailure("not_allowed") });
      await request(refused)
        .get("/api/auth/google/callback?code=fake-auth-code")
        .set("Cookie", refusedPreAuth.cookie);

      const written = consoleWrites(spies).join(" ");

      for (const secret of SECRET_VALUES) {
        expect(written).not.toContain(secret);
      }
      expect(written).not.toContain("not_allowed");
      // None of the above is a fault, so nothing should be logged at all.
      expect(spies.error).not.toHaveBeenCalled();
      expect(written).toBe("");
    });
  });
});
