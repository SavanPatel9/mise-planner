// The decision half of the Google verify callback, kept free of Passport and
// Prisma so it can be tested as a plain function: dependencies arrive as
// arguments and the result is a value, never a `done(...)` call.
//
// Checks run in a fixed order and every rejection returns before any database
// call — a non-allowlisted account must leave no row behind:
//
//   1. no primary email on the profile      -> no_email
//   2. Google has not verified that email   -> email_unverified
//   3. the email is not on the allowlist     -> not_allowed
//
// The OAuth tokens are carried through to the caller for M2-T6 to encrypt and
// store. Nothing here persists or logs them, the profile, or the address.

/** Requested at authorization time and the default recorded on success. */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

/** Space-delimited form, as OAuth transmits it and `Integration.scopes` stores it. */
export const GOOGLE_SCOPE_STRING = GOOGLE_SCOPES.join(" ");

/**
 * The parts of a `passport-google-oauth20` profile this module reads, typed
 * loosely enough that a caller need not have the whole payload. `verified` and
 * `email_verified` are both the OpenID `email_verified` claim, which arrives as
 * a boolean from the userinfo endpoint but as the string `"true"` from some
 * Google endpoints.
 */
export interface GoogleProfileLike {
  displayName?: string | undefined;
  emails?:
    | Array<{
        value?: string | undefined;
        verified?: boolean | string | undefined;
      }>
    | undefined;
  _json?:
    | {
        email_verified?: boolean | string | undefined;
        name?: string | undefined;
      }
    | undefined;
}

/** The signed-in user, as stored on the session's `req.user`. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  /**
   * Live credentials for this sign-in. Handed to the integration service
   * (M2-T6) to encrypt at rest — never serialized into the session, returned to
   * the client, or logged.
   */
  google: {
    accessToken: string;
    refreshToken: string | null;
    scopes: string;
  };
}

export type VerifyFailureReason =
  "no_email" | "email_unverified" | "not_allowed";

export type VerifyGoogleProfileResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; reason: VerifyFailureReason };

export interface UpsertUserInput {
  email: string;
  name: string | null;
}

export interface UpsertedUser {
  id: string;
  email: string;
  name: string | null;
}

export interface VerifyGoogleProfileDeps {
  /** Abstracts the Prisma upsert so the core stays database-free. */
  upsertUser: (input: UpsertUserInput) => Promise<UpsertedUser>;
  isAllowed: (email: string) => boolean;
}

export interface VerifyGoogleProfileInput {
  profile: GoogleProfileLike;
  accessToken: string;
  /** Absent unless the authorization request asked for offline access. */
  refreshToken?: string | null | undefined;
  /** Scopes Google actually granted; defaults to the ones requested. */
  scopes?: string | undefined;
}

/**
 * The primary address, lowercased here and nowhere else downstream: the
 * allowlist compares case-insensitively, so a mixed-case `Chef@Mise.test`
 * would pass the check and then upsert on a key that misses the existing
 * lowercase row — a duplicate user for the same account. One normalization
 * step keeps the check and the upsert on the same string.
 */
function readPrimaryEmail(profile: GoogleProfileLike): string | undefined {
  const value = profile.emails?.[0]?.value;
  if (typeof value !== "string") {
    return undefined;
  }

  const email = value.trim().toLowerCase();
  return email === "" ? undefined : email;
}

function isEmailVerified(profile: GoogleProfileLike): boolean {
  // First source that states the claim wins; a profile stating neither counts
  // as unverified.
  const claim = profile.emails?.[0]?.verified ?? profile._json?.email_verified;

  return claim === true || claim === "true";
}

function readName(profile: GoogleProfileLike): string | null {
  const name = profile.displayName ?? profile._json?.name;

  return typeof name === "string" && name.trim() !== "" ? name : null;
}

/**
 * Decides whether a Google profile may sign in and, if so, upserts the user.
 * Rejections are ordinary results, not exceptions; only a failing `upsertUser`
 * rejects, which the caller treats as an infrastructure fault.
 */
export async function verifyGoogleProfile(
  deps: VerifyGoogleProfileDeps,
  input: VerifyGoogleProfileInput,
): Promise<VerifyGoogleProfileResult> {
  const email = readPrimaryEmail(input.profile);
  if (email === undefined) {
    return { ok: false, reason: "no_email" };
  }

  if (!isEmailVerified(input.profile)) {
    return { ok: false, reason: "email_unverified" };
  }

  if (!deps.isAllowed(email)) {
    return { ok: false, reason: "not_allowed" };
  }

  // Google's email is the identity key, so the upsert both creates the user and
  // keeps a renamed account's display name current.
  const user = await deps.upsertUser({ email, name: readName(input.profile) });

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      google: {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? null,
        scopes: input.scopes ?? GOOGLE_SCOPE_STRING,
      },
    },
  };
}
