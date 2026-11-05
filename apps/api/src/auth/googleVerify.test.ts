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
        google: {
          accessToken: string;
          refreshToken?: string | null;
          scopes?: string | string[];
        };
      };
    }
  | { ok: false; reason: string };

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
  } = {},
) {
  return {
    upsertUser:
      overrides.upsertUser ??
      vi.fn(async () => ({ id: USER_ID, email: EMAIL, name: NAME })),
    isAllowed: overrides.isAllowed ?? vi.fn(() => true),
  };
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

  it("upserts once and returns the user with its Google tokens", async () => {
    const deps = buildDeps();

    const result = await verify(deps, buildInput());

    expect(result.ok).toBe(true);
    expect(deps.upsertUser).toHaveBeenCalledTimes(1);
    expect(deps.upsertUser).toHaveBeenCalledWith({ email: EMAIL, name: NAME });

    if (!result.ok) return;
    expect(result.user.id).toBe(USER_ID);
    expect(result.user.email).toBe(EMAIL);
    expect(result.user.name).toBe(NAME);
    expect(result.user.google.accessToken).toBe(ACCESS_TOKEN);
    expect(result.user.google.refreshToken).toBe(REFRESH_TOKEN);
  });

  it("records the scopes Google actually granted", async () => {
    const result = await verify(buildDeps(), buildInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verbatim: the strategy adapter reads the granted `params.scope` off the
    // token response and the core must store it as-is, not re-derive it from
    // what was requested.
    expect(result.user.google.scopes).toBe(GRANTED_SCOPE);
    expect(scopeList(result.user.google.scopes)).toEqual(
      scopeList(GRANTED_SCOPE),
    );
  });

  it("records a narrower grant without re-adding what was only requested", async () => {
    // Google returns the scopes the user actually consented to; if Calendar was
    // declined, nothing may pretend otherwise.
    const granted = "openid email profile";

    const result = await verify(buildDeps(), {
      ...buildInput(),
      scopes: granted,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.user.google.scopes).toBe(granted);
    expect(scopeList(result.user.google.scopes)).not.toContain(CALENDAR_SCOPE);
  });

  it("falls back to the requested Calendar scope when none are reported", async () => {
    const result = await verify(buildDeps(), {
      ...buildInput(),
      scopes: undefined,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const scopes = scopeList(result.user.google.scopes);
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes).toContain(CALENDAR_SCOPE);
  });

  it("consults the allowlist with the profile email", async () => {
    const deps = buildDeps();

    await verify(deps, buildInput());

    expect(deps.isAllowed).toHaveBeenCalledTimes(1);
    expect(deps.isAllowed).toHaveBeenCalledWith(EMAIL);
  });

  it("normalizes a padded, mixed-case address before the allowlist and the upsert", async () => {
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
    if (!result.ok) return;
    expect(result.user.google.accessToken).toBe(ACCESS_TOKEN);
    // Nothing to store; M2-T5 is responsible for not clobbering the saved one.
    expect(result.user.google.refreshToken).toBeFalsy();
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
