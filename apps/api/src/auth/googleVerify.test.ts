import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyGoogleProfile } from "./googleVerify.js";

// Fixture values only. They are distinctive so a leak into console output is
// unambiguous — see "writes nothing to the console".
const EMAIL = "chef@mise.test";
const NAME = "Mise Chef";
const GOOGLE_ID = "google-subject-1001";
const USER_ID = "user-cuid-1001";
const ACCESS_TOKEN = "ya29.access-token-sentinel-4f1a";
const REFRESH_TOKEN = "1//refresh-token-sentinel-9c3e";
const STRANGER_EMAIL = "stranger@elsewhere.test";
// The same address as EMAIL as Google may hand it over: padded and mixed case.
const MIXED_CASE_EMAIL = "  Chef@Mise.TEST ";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const GRANTED_SCOPE = `openid email profile ${CALENDAR_SCOPE}`;

type VerifyResult =
  | {
      ok: true;
      user: {
        id: string;
        email: string;
        name?: string | null;
      };
    }
  | { ok: false; reason: string };

/** What the core hands the integration service for this sign-in. */
interface PersistedTokens {
  userId: string;
  accountEmail: string;
  accessToken: string;
  refreshToken: string | null;
  scopes: string;
}

interface TestEmail {
  value: string;
  verified?: boolean | string;
}

interface TestProfile {
  id: string;
  provider: string;
  displayName?: string;
  emails?: TestEmail[];
  _json: {
    sub: string;
    email?: string;
    email_verified?: boolean | string;
    name?: string;
  };
}

/**
 * A passport-google-oauth20 shaped profile. Overrides are merged shallowly so a
 * test can drop `emails` or flip verification without restating the fixture.
 */
function buildProfile(overrides: Partial<TestProfile> = {}): TestProfile {
  return {
    id: GOOGLE_ID,
    provider: "google",
    displayName: NAME,
    emails: [{ value: EMAIL, verified: true }],
    _json: {
      sub: GOOGLE_ID,
      email: EMAIL,
      email_verified: true,
      name: NAME,
    },
    ...overrides,
  };
}

interface TestInput {
  profile: TestProfile;
  accessToken: string;
  refreshToken?: string | null | undefined;
  scopes?: string | undefined;
}

function buildInput(profile: TestProfile = buildProfile()): TestInput {
  return {
    profile,
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    scopes: GRANTED_SCOPE,
  };
}

function buildDeps(
  overrides: {
    upsertUser?: ReturnType<typeof vi.fn>;
    isAllowed?: ReturnType<typeof vi.fn>;
    persistGoogleTokens?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    upsertUser:
      overrides.upsertUser ??
      vi.fn(async () => ({ id: USER_ID, email: EMAIL, name: NAME })),
    isAllowed: overrides.isAllowed ?? vi.fn(() => true),
    // The tokens leave the core through this dependency and nowhere else, so
    // every assertion about them is an assertion about its call.
    persistGoogleTokens:
      overrides.persistGoogleTokens ?? vi.fn(async () => undefined),
  };
}

/** The one call the token write should have received. */
function persistedTokens(deps: ReturnType<typeof buildDeps>): PersistedTokens {
  const args = deps.persistGoogleTokens.mock.calls[0]?.[0];
  expect(args, "expected the tokens to be handed to the store").toBeDefined();

  return args as PersistedTokens;
}

/**
 * Boolean, not an assertion, so a failing leak check can never make vitest
 * print a token.
 */
function serializationMentions(value: unknown, secret: string): boolean {
  if (secret.length === 0) return false;
  return JSON.stringify(value ?? null).includes(secret);
}

/**
 * An upsert that echoes the address it was given, the way the real Prisma
 * upsert returns the row it wrote. A fixed-email stub would make an assertion
 * on `result.user.email` pass no matter what the core sent to the database.
 */
function echoingUpsert() {
  return vi.fn(async (input: unknown) => ({
    id: USER_ID,
    email: String((input as { email?: unknown } | undefined)?.email ?? ""),
    name: NAME,
  }));
}

// The verify core is called through `as never` because its parameter types live
// in the module under test; the fixtures above pin the shape the strategy
// actually hands it.
const verifyCore = verifyGoogleProfile as unknown as (
  deps: unknown,
  input: unknown,
) => Promise<VerifyResult>;

async function verify(
  deps: ReturnType<typeof buildDeps>,
  input: TestInput,
): Promise<VerifyResult> {
  return await verifyCore(deps, input);
}

/**
 * `upsertUser`'s call signature (one object vs. positional args) is an
 * implementation detail; what matters is that it is reached exactly once with
 * the right identity.
 */
function upsertIdentity(upsertUser: ReturnType<typeof vi.fn>) {
  const args = upsertUser.mock.calls[0] ?? [];
  const first = args[0] as Record<string, unknown> | string | undefined;

  if (first && typeof first === "object") {
    return {
      email: String(first.email ?? ""),
      name: first.name === undefined ? undefined : String(first.name ?? ""),
    };
  }

  return {
    email: String(first ?? ""),
    name: args[1] === undefined ? undefined : String(args[1] ?? ""),
  };
}

function scopeList(scopes: string | string[] | undefined): string[] {
  if (Array.isArray(scopes)) {
    return scopes;
  }

  return typeof scopes === "string" ? scopes.split(/\s+/).filter(Boolean) : [];
}

describe("verifyGoogleProfile", () => {
  beforeEach(() => {
    // The core takes `isAllowed` as a dependency, but a stray env read must not
    // silently widen the allowlist either.
    vi.stubEnv("ALLOWED_EMAILS", EMAIL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("upserts once, hands the tokens to the store, and returns an identity-only user", async () => {
    const deps = buildDeps();

    const result = await verify(deps, buildInput());

    expect(result.ok).toBe(true);
    expect(deps.upsertUser).toHaveBeenCalledTimes(1);
    expect(deps.upsertUser).toHaveBeenCalledWith({ email: EMAIL, name: NAME });

    expect(deps.persistGoogleTokens).toHaveBeenCalledTimes(1);
    expect(persistedTokens(deps)).toEqual({
      userId: USER_ID,
      accountEmail: EMAIL,
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      scopes: GRANTED_SCOPE,
    });

    if (!result.ok) return;
    expect(result.user.id).toBe(USER_ID);
    expect(result.user.email).toBe(EMAIL);
    expect(result.user.name).toBe(NAME);
    // Identity only: `req.user` goes into a session and gets serialized by
    // anything downstream, so a token riding along on it is a leak. The exact
    // key set is the assertion — a differently named token field would pass a
    // check for the absence of `google`.
    expect(Object.keys(result.user).sort()).toEqual(["email", "id", "name"]);
    expect(serializationMentions(result.user, ACCESS_TOKEN)).toBe(false);
    expect(serializationMentions(result.user, REFRESH_TOKEN)).toBe(false);
  });

  it("stores the tokens under the id the upsert returned", async () => {
    const storedId = "user-cuid-from-upsert";
    const deps = buildDeps({
      upsertUser: vi.fn(async () => ({
        id: storedId,
        email: EMAIL,
        name: NAME,
      })),
    });

    await verify(deps, buildInput());

    // The row is keyed on the user that was just written, never on anything
    // read off the profile.
    expect(persistedTokens(deps).userId).toBe(storedId);
  });

  it("stores the tokens only after the user row exists", async () => {
    const deps = buildDeps();

    await verify(deps, buildInput());

    // The integration row carries a FK to the user, so the order is not a
    // detail: persisting first would fail the constraint.
    const upsertOrder = deps.upsertUser.mock.invocationCallOrder[0] ?? 0;
    const persistOrder =
      deps.persistGoogleTokens.mock.invocationCallOrder[0] ?? 0;
    expect(upsertOrder).toBeGreaterThan(0);
    expect(persistOrder).toBeGreaterThan(upsertOrder);
  });

  it("records the scopes Google actually granted", async () => {
    const deps = buildDeps();

    const result = await verify(deps, buildInput());

    expect(result.ok).toBe(true);

    // Verbatim: the strategy adapter reads the granted `params.scope` off the
    // token response and the core must store it as-is, not re-derive it from
    // what was requested.
    expect(persistedTokens(deps).scopes).toBe(GRANTED_SCOPE);
    expect(scopeList(persistedTokens(deps).scopes)).toEqual(
      scopeList(GRANTED_SCOPE),
    );
  });

  it("records a narrower grant without re-adding what was only requested", async () => {
    // Google returns the scopes the user actually consented to; if Calendar was
    // declined, nothing may pretend otherwise.
    const granted = "openid email profile";
    const deps = buildDeps();

    const result = await verify(deps, {
      ...buildInput(),
      scopes: granted,
    });

    expect(result.ok).toBe(true);
    expect(persistedTokens(deps).scopes).toBe(granted);
    expect(scopeList(persistedTokens(deps).scopes)).not.toContain(
      CALENDAR_SCOPE,
    );
  });

  it("falls back to the requested Calendar scope when none are reported", async () => {
    const deps = buildDeps();

    const result = await verify(deps, {
      ...buildInput(),
      scopes: undefined,
    });

    expect(result.ok).toBe(true);

    const scopes = scopeList(persistedTokens(deps).scopes);
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes).toContain(CALENDAR_SCOPE);
  });

  it("consults the allowlist with the profile email", async () => {
    const deps = buildDeps();

    await verify(deps, buildInput());

    expect(deps.isAllowed).toHaveBeenCalledTimes(1);
    expect(deps.isAllowed).toHaveBeenCalledWith(EMAIL);
  });

  it("normalizes a padded, mixed-case address before the allowlist, the upsert and the token write", async () => {
    const deps = buildDeps({ upsertUser: echoingUpsert() });

    const result = await verify(
      deps,
      buildInput(
        buildProfile({
          emails: [{ value: MIXED_CASE_EMAIL, verified: true }],
          _json: {
            sub: GOOGLE_ID,
            email: MIXED_CASE_EMAIL,
            email_verified: true,
            name: NAME,
          },
        }),
      ),
    );

    expect(result.ok).toBe(true);

    // Exact match, not a case-insensitive one: `User.email` is unique, so
    // "Chef@Mise.TEST" reaching the upsert would create a second row for the
    // same person on the next sign-in.
    expect(deps.isAllowed).toHaveBeenCalledTimes(1);
    expect(deps.isAllowed).toHaveBeenCalledWith(EMAIL);
    expect(deps.upsertUser).toHaveBeenCalledTimes(1);
    expect(upsertIdentity(deps.upsertUser).email).toBe(EMAIL);
    // Same string again for the integration row: its composite unique includes
    // the address, so a mixed-case one would open a second grant for the
    // account already stored in lowercase.
    expect(persistedTokens(deps).accountEmail).toBe(EMAIL);

    if (!result.ok) return;
    expect(result.user.email).toBe(EMAIL);
  });

  it("keeps an already-normalized address byte-identical through the upsert", async () => {
    const deps = buildDeps({ upsertUser: echoingUpsert() });

    const result = await verify(deps, buildInput());

    expect(result.ok).toBe(true);
    expect(upsertIdentity(deps.upsertUser).email).toBe(EMAIL);

    if (!result.ok) return;
    expect(result.user.email).toBe(EMAIL);
  });

  it("rejects a disallowed address without touching the database", async () => {
    const deps = buildDeps({ isAllowed: vi.fn(() => false) });

    const result = await verify(deps, buildInput());

    expect(result).toEqual({ ok: false, reason: "not_allowed" });
    expect(deps.upsertUser).not.toHaveBeenCalled();
  });

  it("rejects a profile with no emails array", async () => {
    const deps = buildDeps();
    const profile = buildProfile();
    delete profile.emails;
    profile._json = { sub: GOOGLE_ID };

    const result = await verify(deps, buildInput(profile));

    expect(result).toEqual({ ok: false, reason: "no_email" });
    expect(deps.upsertUser).not.toHaveBeenCalled();
  });

  it("rejects a profile with an empty emails array", async () => {
    const deps = buildDeps();

    const result = await verify(
      deps,
      buildInput(buildProfile({ emails: [], _json: { sub: GOOGLE_ID } })),
    );

    expect(result).toEqual({ ok: false, reason: "no_email" });
    expect(deps.upsertUser).not.toHaveBeenCalled();
  });

  it("rejects a primary email that is an empty string", async () => {
    const deps = buildDeps();

    const result = await verify(
      deps,
      buildInput(
        buildProfile({
          emails: [{ value: "", verified: true }],
          _json: { sub: GOOGLE_ID, email: "", email_verified: true },
        }),
      ),
    );

    expect(result).toEqual({ ok: false, reason: "no_email" });
    expect(deps.upsertUser).not.toHaveBeenCalled();
  });

  it("falls back to the OpenID name when the profile has no display name", async () => {
    const deps = buildDeps();
    const profile = buildProfile();
    delete profile.displayName;

    await verify(deps, buildInput(profile));

    expect(upsertIdentity(deps.upsertUser).name).toBe(NAME);
  });

  it("upserts a null name when the profile states none", async () => {
    const deps = buildDeps();

    await verify(
      deps,
      buildInput(
        buildProfile({
          displayName: "   ",
          _json: { sub: GOOGLE_ID, email: EMAIL, email_verified: true },
        }),
      ),
    );

    expect(deps.upsertUser).toHaveBeenCalledTimes(1);
    // Blank is not a name; the column stays null rather than holding spaces.
    expect(deps.upsertUser).toHaveBeenCalledWith({ email: EMAIL, name: null });
  });

  it("never upserts a blank-ish primary email", async () => {
    const deps = buildDeps();

    const result = await verify(
      deps,
      buildInput(
        buildProfile({
          emails: [{ value: "   ", verified: true }],
          _json: { sub: GOOGLE_ID, email: "   ", email_verified: true },
        }),
      ),
    );

    // Whitespace is no address: it must never reach the database, nor be
    // handed to the allowlist as a candidate.
    expect(result).toEqual({ ok: false, reason: "no_email" });
    expect(deps.upsertUser).not.toHaveBeenCalled();
    expect(deps.isAllowed).not.toHaveBeenCalled();
  });

  it("rejects an unverified email", async () => {
    const deps = buildDeps();

    const result = await verify(
      deps,
      buildInput(
        buildProfile({
          emails: [{ value: EMAIL, verified: false }],
          _json: { sub: GOOGLE_ID, email: EMAIL, email_verified: false },
        }),
      ),
    );

    expect(result).toEqual({ ok: false, reason: "email_unverified" });
    expect(deps.upsertUser).not.toHaveBeenCalled();
  });

  it("rejects a profile that never states verification", async () => {
    const deps = buildDeps();

    const result = await verify(
      deps,
      buildInput(
        buildProfile({
          emails: [{ value: EMAIL }],
          _json: { sub: GOOGLE_ID, email: EMAIL },
        }),
      ),
    );

    expect(result).toEqual({ ok: false, reason: "email_unverified" });
    expect(deps.upsertUser).not.toHaveBeenCalled();
  });

  it('treats the string "true" as verified', async () => {
    const deps = buildDeps();

    const fromEmails = await verify(
      deps,
      buildInput(
        buildProfile({
          emails: [{ value: EMAIL, verified: "true" }],
          _json: { sub: GOOGLE_ID, email: EMAIL },
        }),
      ),
    );
    expect(fromEmails.ok).toBe(true);

    const fromJson = await verify(
      deps,
      buildInput(
        buildProfile({
          emails: [{ value: EMAIL }],
          _json: { sub: GOOGLE_ID, email: EMAIL, email_verified: "true" },
        }),
      ),
    );
    expect(fromJson.ok).toBe(true);
  });

  it('does not accept the string "false" as verified', async () => {
    const deps = buildDeps();

    const result = await verify(
      deps,
      buildInput(
        buildProfile({
          emails: [{ value: EMAIL, verified: "false" }],
          _json: { sub: GOOGLE_ID, email: EMAIL, email_verified: "false" },
        }),
      ),
    );

    expect(result).toEqual({ ok: false, reason: "email_unverified" });
    expect(deps.upsertUser).not.toHaveBeenCalled();
  });

  it("fails closed when the two verification claims disagree", async () => {
    const deps = buildDeps();

    const result = await verify(
      deps,
      buildInput(
        buildProfile({
          emails: [{ value: EMAIL, verified: false }],
          _json: { sub: GOOGLE_ID, email: EMAIL, email_verified: true },
        }),
      ),
    );

    expect(result).toEqual({ ok: false, reason: "email_unverified" });
    expect(deps.upsertUser).not.toHaveBeenCalled();
  });

  it("reports a missing email before consulting the allowlist", async () => {
    const deps = buildDeps({ isAllowed: vi.fn(() => false) });
    const profile = buildProfile();
    delete profile.emails;
    profile._json = { sub: GOOGLE_ID };

    const result = await verify(deps, buildInput(profile));

    expect(result).toEqual({ ok: false, reason: "no_email" });
    expect(deps.isAllowed).not.toHaveBeenCalled();
    expect(deps.upsertUser).not.toHaveBeenCalled();
  });

  it("reports an unverified email before reporting a disallowed one", async () => {
    const deps = buildDeps({ isAllowed: vi.fn(() => false) });

    const result = await verify(
      deps,
      buildInput(
        buildProfile({
          emails: [{ value: STRANGER_EMAIL, verified: false }],
          _json: {
            sub: GOOGLE_ID,
            email: STRANGER_EMAIL,
            email_verified: false,
          },
        }),
      ),
    );

    expect(result).toEqual({ ok: false, reason: "email_unverified" });
    expect(deps.upsertUser).not.toHaveBeenCalled();
  });

  it("succeeds without a refresh token on re-consent", async () => {
    const deps = buildDeps();
    const result = await verify(deps, {
      ...buildInput(),
      refreshToken: undefined,
    });

    expect(result.ok).toBe(true);
    expect(deps.upsertUser).toHaveBeenCalledTimes(1);
    expect(persistedTokens(deps).accessToken).toBe(ACCESS_TOKEN);
    // Explicitly null rather than undefined: the store distinguishes "no
    // refresh token this time" (leave the stored one alone) from a value, and
    // an absent key would be read as the latter by a loose check.
    expect(persistedTokens(deps).refreshToken).toBeNull();
  });

  it("passes a null refresh token through as null", async () => {
    const deps = buildDeps();

    await verify(deps, { ...buildInput(), refreshToken: null });

    expect(persistedTokens(deps).refreshToken).toBeNull();
  });

  it("propagates an upsert failure instead of swallowing it", async () => {
    const failure = new Error("upsert failed");
    const deps = buildDeps({
      upsertUser: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(verify(deps, buildInput())).rejects.toBe(failure);
    expect(deps.upsertUser).toHaveBeenCalledTimes(1);
    // Nothing to store under a user that was never written.
    expect(deps.persistGoogleTokens).not.toHaveBeenCalled();
  });

  it("refuses the sign-in when the token write fails", async () => {
    const deps = buildDeps({
      persistGoogleTokens: vi.fn(async () => {
        throw new Error(`write failed for ${EMAIL}: ${ACCESS_TOKEN}`);
      }),
    });

    const result = await verify(deps, buildInput());

    // A session with no stored credentials could never reach Google again, so
    // the write failing is a refusal rather than a sign-in. Deep equality: the
    // result carries the fixed reason and nothing of the error or the account.
    expect(result).toEqual({ ok: false, reason: "token_persist_failed" });
    expect(serializationMentions(result, ACCESS_TOKEN)).toBe(false);
    expect(serializationMentions(result, EMAIL)).toBe(false);
    expect(deps.persistGoogleTokens).toHaveBeenCalledTimes(1);
  });

  it("refuses rather than rethrowing when the token write rejects with a non-Error", async () => {
    const deps = buildDeps({
      persistGoogleTokens: vi.fn(async () => {
        throw "store exploded";
      }),
    });

    await expect(verify(deps, buildInput())).resolves.toEqual({
      ok: false,
      reason: "token_persist_failed",
    });
  });

  it("never reaches the token write for a refused profile", async () => {
    const noEmail = buildProfile();
    delete noEmail.emails;
    noEmail._json = { sub: GOOGLE_ID };

    const cases: Array<[string, ReturnType<typeof buildDeps>, TestInput]> = [
      ["no_email", buildDeps(), buildInput(noEmail)],
      [
        "email_unverified",
        buildDeps(),
        buildInput(
          buildProfile({
            emails: [{ value: EMAIL, verified: false }],
            _json: { sub: GOOGLE_ID, email: EMAIL, email_verified: false },
          }),
        ),
      ],
      [
        "not_allowed",
        buildDeps({ isAllowed: vi.fn(() => false) }),
        buildInput(
          buildProfile({
            emails: [{ value: STRANGER_EMAIL, verified: true }],
            _json: {
              sub: GOOGLE_ID,
              email: STRANGER_EMAIL,
              email_verified: true,
            },
          }),
        ),
      ],
    ];

    for (const [reason, deps, input] of cases) {
      const result = await verify(deps, input);

      // Every rejection returns before any write: a non-allowlisted account
      // must leave neither a user row nor a stored token behind.
      expect(result).toEqual({ ok: false, reason });
      expect(deps.upsertUser).not.toHaveBeenCalled();
      expect(deps.persistGoogleTokens).not.toHaveBeenCalled();
    }
  });

  it("writes nothing to the console on success or rejection", async () => {
    const spies = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    };

    await verify(buildDeps(), buildInput());
    await verify(buildDeps({ isAllowed: vi.fn(() => false) }), buildInput());
    // The caller logs a failed token write (as a class name); this layer must
    // stay silent even though it holds the tokens and the address.
    await verify(
      buildDeps({
        persistGoogleTokens: vi.fn(async () => {
          throw new Error(`write failed for ${EMAIL}: ${REFRESH_TOKEN}`);
        }),
      }),
      buildInput(),
    );

    const written = Object.values(spies)
      .flatMap((spy) => spy.mock.calls.flat())
      .map((entry) =>
        typeof entry === "string" ? entry : JSON.stringify(entry),
      )
      .join(" ");

    expect(written).not.toContain(ACCESS_TOKEN);
    expect(written).not.toContain(REFRESH_TOKEN);
    expect(written).not.toContain(EMAIL);
    expect(written).not.toContain(GOOGLE_ID);
  });
});
