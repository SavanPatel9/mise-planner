import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prisma is mocked at the module boundary so importing the wiring never loads a
// real client or opens a connection. The spies live outside the factory
// (`vi.hoisted`) so they survive the `vi.resetModules()` each test does — the
// factory re-runs, but it hands back these same functions.
const db = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@mise/db", () => ({
  prisma: { user: { upsert: db.upsert, findUnique: db.findUnique } },
}));

// Fixture values only, deliberately distinctive so a leak into an error message
// or the session payload is unambiguous.
const EMAIL = "chef@mise.test";
// The same address as Google may hand it over: padded and mixed case.
const RAW_EMAIL = "  Chef@Mise.TEST ";
const STRANGER_EMAIL = "stranger@elsewhere.test";
const NAME = "Mise Chef";
const GOOGLE_ID = "google-subject-2001";
const USER_ID = "user-cuid-2001";
const ACCESS_TOKEN = "ya29.access-token-sentinel-8d2c";
const REFRESH_TOKEN = "1//refresh-token-sentinel-3e7b";
const CLIENT_ID = "client-id-sentinel-11aa";
const CLIENT_SECRET = "client-secret-sentinel-22bb";
const CALLBACK_URL = "https://mise.test/api/auth/google/callback";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const REQUESTED_SCOPES = ["openid", "email", "profile", CALENDAR_SCOPE];
/** A partial consent: Calendar declined, so the recorded grant is narrower. */
const GRANTED_SCOPE = "openid email";

const GOOGLE_ENV_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL",
] as const;

const SECRET_VALUES = [CLIENT_ID, CLIENT_SECRET, CALLBACK_URL];

/** How long a `done` callback is given before the test calls it a failure. */
const DONE_TIMEOUT_MS = 1000;

type DoneArgs = {
  err: unknown;
  user: unknown;
  info: unknown;
  /** How many arguments `done` was actually handed. */
  argc: number;
};
type Done = (...args: unknown[]) => void;

/** Only the internals these tests read; the public API exposes no registry. */
interface StrategyInternals {
  name?: string;
  _verify: (...args: unknown[]) => void;
  _scope?: string | string[] | undefined;
  _stateStore?: {
    store: (...args: unknown[]) => void;
    verify: (...args: unknown[]) => void;
    /** Session key — the session-backed stores have one, `NullStore` does not. */
    _key?: string;
  };
  _pkceMethod?: string | false | undefined;
}

interface PassportInternals {
  _strategy: (name: string) => StrategyInternals | undefined;
  _serializers: Array<(user: unknown, done: Done) => void>;
  _deserializers: Array<(id: unknown, done: Done) => void>;
}

interface TestProfile {
  id: string;
  provider: string;
  displayName?: string;
  emails?: Array<{ value: string; verified?: boolean | string }>;
  _json: {
    sub: string;
    email?: string;
    email_verified?: boolean | string;
    name?: string;
  };
}

function buildProfile(overrides: Partial<TestProfile> = {}): TestProfile {
  return {
    id: GOOGLE_ID,
    provider: "google",
    displayName: NAME,
    emails: [{ value: RAW_EMAIL, verified: true }],
    _json: {
      sub: GOOGLE_ID,
      email: RAW_EMAIL,
      email_verified: true,
      name: NAME,
    },
    ...overrides,
  };
}

/**
 * `configurePassport` latches its serializer registration in a module-level
 * flag, so each test takes a fresh copy of the wiring. Note that
 * `vi.resetModules()` only clears
 * inlined source modules — `passport` itself is externalized, so its singleton
 * (and its serializer arrays) persists for the whole file; see
 * `registeredSerializers`.
 */
async function loadPassport(): Promise<{
  configurePassport: () => void;
  authParams: unknown;
  passport: PassportInternals;
}> {
  vi.resetModules();
  const wiring = await import("./passport.js");
  const { default: passport } = await import("passport");

  return {
    configurePassport: wiring.configurePassport,
    authParams: wiring.GOOGLE_AUTH_PARAMS,
    passport: passport as unknown as PassportInternals,
  };
}

/**
 * Runs `configure` and returns only the serializers it appended, so assertions
 * are never satisfied by one an earlier test left on the shared singleton.
 */
function registeredSerializers(
  passport: PassportInternals,
  configure: () => void,
): {
  serialize: (user: unknown, done: Done) => void;
  deserialize: (id: unknown, done: Done) => void;
} {
  const before = {
    serializers: passport._serializers.length,
    deserializers: passport._deserializers.length,
  };

  configure();

  const serializers = passport._serializers.slice(before.serializers);
  const deserializers = passport._deserializers.slice(before.deserializers);
  expect(serializers, "expected one serializer to be registered").toHaveLength(
    1,
  );
  expect(
    deserializers,
    "expected one deserializer to be registered",
  ).toHaveLength(1);

  return {
    serialize: serializers[0] as (user: unknown, done: Done) => void,
    deserialize: deserializers[0] as (id: unknown, done: Done) => void,
  };
}

/** Configures a fresh copy of the wiring and returns what it registered. */
async function loadConfigured(): Promise<{
  passport: PassportInternals;
  strategy: StrategyInternals;
  serialize: (user: unknown, done: Done) => void;
  deserialize: (id: unknown, done: Done) => void;
}> {
  const { configurePassport, passport } = await loadPassport();
  const { serialize, deserialize } = registeredSerializers(
    passport,
    configurePassport,
  );

  const strategy = passport._strategy("google");
  expect(strategy, "expected a strategy registered as 'google'").toBeDefined();

  return {
    passport,
    strategy: strategy as StrategyInternals,
    serialize,
    deserialize,
  };
}

/**
 * Passport's callback protocol is not promise-based; this resolves on the first
 * `done(...)` and fails loudly rather than hanging if it never arrives.
 */
function awaitDone(
  invoke: (done: Done) => void,
  label: string,
): Promise<DoneArgs> {
  return new Promise<DoneArgs>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: done was never called`));
    }, DONE_TIMEOUT_MS);

    invoke((...args: unknown[]) => {
      clearTimeout(timer);
      resolve({
        err: args[0],
        user: args[1],
        info: args[2],
        argc: args.length,
      });
    });
  });
}

/**
 * Calls the strategy's verify in the exact positional order passport-oauth2
 * uses for a five-argument verify (`lib/strategy.js`): a swapped `params` and
 * `profile` here is what would make every sign-in fail as `no_email`.
 */
function runVerify(
  strategy: StrategyInternals,
  args: {
    accessToken?: string;
    refreshToken?: string | undefined;
    params?: unknown;
    profile?: unknown;
  } = {},
): Promise<DoneArgs> {
  const {
    accessToken = ACCESS_TOKEN,
    params = { scope: GRANTED_SCOPE },
    profile = buildProfile(),
  } = args;
  // `undefined` is a meaningful value here (Google omits the refresh token on a
  // repeat consent), so a destructuring default would hide the case under test.
  const refreshToken =
    "refreshToken" in args ? args.refreshToken : REFRESH_TOKEN;

  return awaitDone((done) => {
    strategy._verify(accessToken, refreshToken, params, profile, done);
  }, "strategy verify");
}

interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  google: { accessToken: string; refreshToken: string | null; scopes: string };
}

function asSessionUser(user: unknown): SessionUser {
  expect(user, "expected done to receive a user").toBeTruthy();

  return user as SessionUser;
}

function scopeList(scope: unknown): string[] {
  if (Array.isArray(scope)) {
    return scope.map(String);
  }

  return typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [];
}

function firstCallArg(spy: typeof db.upsert): Record<string, unknown> {
  const arg = spy.mock.calls[0]?.[0];
  expect(arg, "expected the query to be called with an argument").toBeTruthy();

  return arg as Record<string, unknown>;
}

describe("configurePassport", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("GOOGLE_CALLBACK_URL", CALLBACK_URL);
    vi.stubEnv("ALLOWED_EMAILS", EMAIL);

    db.upsert.mockReset();
    db.findUnique.mockReset();
    db.upsert.mockResolvedValue({ id: USER_ID, email: EMAIL, name: NAME });
    db.findUnique.mockResolvedValue({ id: USER_ID, email: EMAIL, name: NAME });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("strategy registration", () => {
    it("registers a Google strategy whose verify takes the five-argument form", async () => {
      const { strategy } = await loadConfigured();

      expect(strategy.name).toBe("google");
      // passport-oauth2 branches on arity: a four-argument verify never
      // receives the token response, so the granted scopes would be lost.
      expect(strategy._verify.length).toBe(5);
    });

    it("requests openid, email, profile and calendar.readonly", async () => {
      const { strategy } = await loadConfigured();

      const scopes = scopeList(strategy._scope);
      for (const scope of REQUESTED_SCOPES) {
        expect(scopes).toContain(scope);
      }
    });

    it("asks for offline access with a forced consent prompt", async () => {
      const { authParams } = await loadPassport();

      // Google only returns a refresh token for this combination.
      expect(authParams).toMatchObject({
        accessType: "offline",
        prompt: "consent",
      });
    });

    it("binds the callback to the session with state and PKCE", async () => {
      const { strategy } = await loadConfigured();
      const store = strategy._stateStore;

      // The state store is the observable consequence of the options: with
      // neither, passport-oauth2 installs a `NullStore` whose `verify` calls
      // back `true` unconditionally, so the callback would accept any code
      // from any origin. The session-backed PKCE store is discriminated by its
      // session key and its five-argument `store(req, verifier, state, meta,
      // cb)` — `NullStore.store` takes two and has no key.
      expect(store?.constructor.name).toBe("PKCESessionStore");
      expect(store?._key).toBe("oauth2:accounts.google.com");
      expect(store?.store.length).toBe(5);
      // `pkce: true` resolves to the S256 challenge, not the plain one.
      expect(strategy._pkceMethod).toBe("S256");
    });

    it("registers exactly one serializer and deserializer across repeat calls", async () => {
      const { configurePassport, passport } = await loadPassport();
      const before = {
        serializers: passport._serializers.length,
        deserializers: passport._deserializers.length,
      };

      // Every `createApp()` configures again.
      configurePassport();
      configurePassport();
      configurePassport();

      // Passport only ever appends serializers to a process-wide singleton;
      // stacking duplicates would run the session lookup once per registration.
      expect(passport._serializers.length - before.serializers).toBe(1);
      expect(passport._deserializers.length - before.deserializers).toBe(1);
    });
  });

  describe("environment validation", () => {
    for (const name of GOOGLE_ENV_VARS) {
      it(`throws naming ${name} when it is unset, without quoting any value`, async () => {
        const { configurePassport } = await loadPassport();
        vi.stubEnv(name, undefined);

        expect(configurePassport).toThrow(`Missing required env var: ${name}`);

        let message = "";
        try {
          configurePassport();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toContain(name);
        for (const value of SECRET_VALUES) {
          expect(message).not.toContain(value);
        }
      });
    }

    it("treats a blank credential as missing", async () => {
      const { configurePassport } = await loadPassport();
      vi.stubEnv("GOOGLE_CLIENT_SECRET", "   \t ");

      expect(configurePassport).toThrow(
        "Missing required env var: GOOGLE_CLIENT_SECRET",
      );
    });

    it("keeps throwing on a repeat call after a credential disappears", async () => {
      const { configurePassport } = await loadPassport();

      expect(configurePassport).not.toThrow();

      // Validation runs before any registration, so the second call must still
      // fail loudly rather than succeed on the latched serializer flag.
      vi.stubEnv("GOOGLE_CALLBACK_URL", undefined);
      expect(configurePassport).toThrow(
        "Missing required env var: GOOGLE_CALLBACK_URL",
      );
    });
  });

  describe("verify adapter", () => {
    it("maps (accessToken, refreshToken, params, profile, done) onto the verify core", async () => {
      const { strategy } = await loadConfigured();
      db.upsert.mockImplementation(
        async (args: { where?: { email?: string } }) => ({
          id: USER_ID,
          email: args.where?.email ?? "",
          name: NAME,
        }),
      );

      const { err, user, info } = await runVerify(strategy);

      expect(err).toBeNull();
      expect(info).toBeUndefined();

      const session = asSessionUser(user);
      // The profile arrived as the profile: a `params` object in its place
      // would have yielded no_email instead of a user.
      expect(session.id).toBe(USER_ID);
      expect(session.email).toBe(EMAIL);
      expect(session.name).toBe(NAME);
      // And `params` arrived as params: the granted scope string is recorded
      // verbatim, narrower than the four scopes that were requested.
      expect(session.google.scopes).toBe(GRANTED_SCOPE);
      expect(scopeList(session.google.scopes)).not.toContain(CALENDAR_SCOPE);
      expect(session.google.accessToken).toBe(ACCESS_TOKEN);
      expect(session.google.refreshToken).toBe(REFRESH_TOKEN);
    });

    it("upserts once on the normalized address and sends no token to the database", async () => {
      const { strategy } = await loadConfigured();

      await runVerify(strategy);

      expect(db.upsert).toHaveBeenCalledTimes(1);
      const args = firstCallArg(db.upsert);
      expect(args.where).toEqual({ email: EMAIL });

      // The identity row holds no credentials; M2-T6 owns the encrypted copy.
      const serialized = JSON.stringify(args);
      expect(serialized).not.toContain(ACCESS_TOKEN);
      expect(serialized).not.toContain(REFRESH_TOKEN);
      expect(serialized).not.toContain(RAW_EMAIL);
    });

    it("leaves a stored name untouched when the profile carries none", async () => {
      const { strategy } = await loadConfigured();
      const profile = buildProfile();
      delete profile.displayName;
      profile._json = {
        sub: GOOGLE_ID,
        email: RAW_EMAIL,
        email_verified: true,
      };

      const { err, user } = await runVerify(strategy, { profile });

      expect(err).toBeNull();
      const args = firstCallArg(db.upsert);
      // A re-consent without the `profile` scope reads as no name at all, so
      // the update must omit the column rather than blank the stored value.
      expect(args.update).toEqual({});
      expect(args.create).toEqual({ email: EMAIL, name: null });
      expect(asSessionUser(user).name).toBe(NAME);
    });

    it("falls back to the requested scopes when the token response reports none", async () => {
      const { strategy } = await loadConfigured();

      for (const params of [{}, { scope: "   " }, { scope: 42 }]) {
        db.upsert.mockClear();
        const { err, user } = await runVerify(strategy, { params });

        expect(err).toBeNull();
        const scopes = scopeList(asSessionUser(user).google.scopes);
        expect(scopes).toEqual(expect.arrayContaining(REQUESTED_SCOPES));
      }
    });

    it("trims a padded granted scope string", async () => {
      const { strategy } = await loadConfigured();

      const { user } = await runVerify(strategy, {
        params: { scope: `  ${GRANTED_SCOPE}  ` },
      });

      expect(asSessionUser(user).google.scopes).toBe(GRANTED_SCOPE);
    });

    it("accepts a sign-in that returns no refresh token", async () => {
      const { strategy } = await loadConfigured();

      const { err, user } = await runVerify(strategy, {
        refreshToken: undefined,
      });

      expect(err).toBeNull();
      expect(asSessionUser(user).google.refreshToken).toBeNull();
    });

    it("refuses a disallowed address with a typed reason and no database write", async () => {
      const { strategy } = await loadConfigured();

      const { err, user, info } = await runVerify(strategy, {
        profile: buildProfile({
          emails: [{ value: STRANGER_EMAIL, verified: true }],
          _json: {
            sub: GOOGLE_ID,
            email: STRANGER_EMAIL,
            email_verified: true,
            name: NAME,
          },
        }),
      });

      // A refusal, not an error: `false` plus a fixed token the callback route
      // can redirect on — and never the address itself.
      expect(err).toBeNull();
      expect(user).toBe(false);
      expect(info).toEqual({ message: "not_allowed" });
      expect(JSON.stringify(info)).not.toContain(STRANGER_EMAIL);
      expect(db.upsert).not.toHaveBeenCalled();
    });

    it("refuses a profile with no usable email before any database write", async () => {
      const { strategy } = await loadConfigured();
      const profile = buildProfile();
      delete profile.emails;
      profile._json = { sub: GOOGLE_ID };

      const { err, user, info } = await runVerify(strategy, { profile });

      expect(err).toBeNull();
      expect(user).toBe(false);
      expect(info).toEqual({ message: "no_email" });
      expect(db.upsert).not.toHaveBeenCalled();
    });

    it("refuses an unverified email", async () => {
      const { strategy } = await loadConfigured();

      const { err, user, info } = await runVerify(strategy, {
        profile: buildProfile({
          emails: [{ value: RAW_EMAIL, verified: false }],
          _json: { sub: GOOGLE_ID, email: RAW_EMAIL, email_verified: false },
        }),
      });

      expect(err).toBeNull();
      expect(user).toBe(false);
      expect(info).toEqual({ message: "email_unverified" });
      expect(db.upsert).not.toHaveBeenCalled();
    });

    it("reports a failing upsert as an error, not a refusal", async () => {
      const { strategy } = await loadConfigured();
      const failure = new Error("upsert failed");
      db.upsert.mockRejectedValue(failure);

      const { err, user } = await runVerify(strategy);

      // Passport ignores the promise the adapter returns, so an uncaught
      // rejection here would surface as an unhandled rejection and the request
      // would hang instead of 500ing.
      expect(err).toBe(failure);
      expect(user).toBeUndefined();
    });

    it("wraps a non-Error upsert rejection in an Error", async () => {
      const { strategy } = await loadConfigured();
      db.upsert.mockRejectedValue("database exploded");

      const { err } = await runVerify(strategy);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("sign-in failed");
    });

    it("writes nothing identifying to the console", async () => {
      const { strategy } = await loadConfigured();
      const spies = {
        log: vi.spyOn(console, "log").mockImplementation(() => {}),
        info: vi.spyOn(console, "info").mockImplementation(() => {}),
        warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
        error: vi.spyOn(console, "error").mockImplementation(() => {}),
        debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
      };

      await runVerify(strategy);
      await runVerify(strategy, {
        profile: buildProfile({
          emails: [{ value: STRANGER_EMAIL, verified: true }],
          _json: {
            sub: GOOGLE_ID,
            email: STRANGER_EMAIL,
            email_verified: true,
          },
        }),
      });

      const written = Object.values(spies)
        .flatMap((spy) => spy.mock.calls.flat())
        .map((entry) =>
          typeof entry === "string" ? entry : JSON.stringify(entry),
        )
        .join(" ");

      expect(written).not.toContain(ACCESS_TOKEN);
      expect(written).not.toContain(REFRESH_TOKEN);
      expect(written).not.toContain(EMAIL);
      expect(written).not.toContain(STRANGER_EMAIL);
      expect(written).not.toContain(CLIENT_SECRET);
    });
  });

  describe("session serializers", () => {
    it("serializes a user to its id and nothing else", async () => {
      const { serialize } = await loadConfigured();
      const user = {
        id: USER_ID,
        email: EMAIL,
        name: NAME,
        google: {
          accessToken: ACCESS_TOKEN,
          refreshToken: REFRESH_TOKEN,
          scopes: GRANTED_SCOPE,
        },
      };

      const {
        err,
        user: serialized,
        argc,
      } = await awaitDone((done) => {
        serialize(user, done);
      }, "serializeUser");

      expect(err).toBeNull();
      // Exactly the id: the cookie-backed session must carry no address and no
      // token, so a whole-object serializer is a leak, not a convenience.
      expect(serialized).toBe(USER_ID);
      expect(typeof serialized).toBe("string");
      expect(argc).toBe(2);

      const payload = JSON.stringify(serialized);
      expect(payload).not.toContain(EMAIL);
      expect(payload).not.toContain(NAME);
      expect(payload).not.toContain(ACCESS_TOKEN);
      expect(payload).not.toContain(REFRESH_TOKEN);
    });

    it("round-trips an id back to the stored user", async () => {
      const { serialize, deserialize } = await loadConfigured();

      const serialized = await awaitDone((done) => {
        serialize({ id: USER_ID, email: EMAIL }, done);
      }, "serializeUser");

      const { err, user } = await awaitDone((done) => {
        deserialize(serialized.user, done);
      }, "deserializeUser");

      expect(err).toBeFalsy();
      expect(user).toEqual({ id: USER_ID, email: EMAIL, name: NAME });

      expect(db.findUnique).toHaveBeenCalledTimes(1);
      const args = firstCallArg(db.findUnique);
      // Looked up by the serialized id, not by anything carried in the session.
      expect(args.where).toEqual({ id: USER_ID });
    });

    it("clears the session of a user that no longer exists", async () => {
      const { deserialize } = await loadConfigured();
      db.findUnique.mockResolvedValue(null);

      const { err, user } = await awaitDone((done) => {
        deserialize(USER_ID, done);
      }, "deserializeUser");

      // A session outliving its row is not a crash; the request continues
      // unauthenticated.
      expect(err).toBeNull();
      expect(user).toBe(false);
    });

    it("reports a failing session lookup as an error", async () => {
      const { deserialize } = await loadConfigured();
      const failure = new Error("findUnique failed");
      db.findUnique.mockRejectedValue(failure);

      const { err, user } = await awaitDone((done) => {
        deserialize(USER_ID, done);
      }, "deserializeUser");

      expect(err).toBe(failure);
      expect(user).toBeFalsy();
    });

    it("wraps a non-Error session lookup rejection in an Error", async () => {
      const { deserialize } = await loadConfigured();
      db.findUnique.mockRejectedValue("connection reset");

      const { err } = await awaitDone((done) => {
        deserialize(USER_ID, done);
      }, "deserializeUser");

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("session lookup failed");
    });
  });
});
