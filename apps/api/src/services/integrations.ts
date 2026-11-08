// Stored provider credentials — the only module that writes or reads an
// `Integration` row. Tokens are encrypted on the way in and decrypted on the
// way out, so no caller ever holds a column value, and every statement is keyed
// on the `[userId, provider, accountEmail]` composite unique: the user scope is
// structural here, not a `where` clause a future query could forget.
//
// Nothing in this module logs. Every argument is a token or an address.
import { prisma, type Provider } from "@mise/db";

import { decrypt, encrypt } from "../crypto/tokenCrypto.js";

/**
 * The provider these helpers are fixed to. The literal is checked against the
 * Prisma enum's type rather than read off the generated enum object, so this
 * module needs no runtime value from `@mise/db` but a renamed member still
 * fails the build.
 */
const GOOGLE = "GOOGLE" satisfies Provider;

/** The composite unique, spelled out so `userId` cannot be left off. */
interface GoogleIntegrationKey {
  userId: string;
  provider: typeof GOOGLE;
  accountEmail: string;
}

interface UpsertArgs {
  where: { userId_provider_accountEmail: GoogleIntegrationKey };
  create: GoogleIntegrationKey & {
    accessTokenEnc: string;
    refreshTokenEnc: string | null;
    scopes: string;
  };
  update: {
    accessTokenEnc: string;
    /** Absent — not null — when this sign-in brought no refresh token. */
    refreshTokenEnc?: string;
    scopes: string;
  };
  select: { id: true };
}

interface FindUniqueArgs {
  where: { userId_provider_accountEmail: GoogleIntegrationKey };
  select: { accessTokenEnc: true; refreshTokenEnc: true; scopes: true };
}

/** The stored columns this module decrypts, as selected above. */
interface StoredRow {
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  scopes: string;
}

/**
 * The slice of the Prisma client used here, narrowed to the two statements this
 * module issues so a test can pass a double instead of a database. The shared
 * singleton is the default argument; nothing here constructs a client.
 */
export interface IntegrationClient {
  integration: {
    upsert: (args: UpsertArgs) => Promise<unknown>;
    findUnique: (args: FindUniqueArgs) => Promise<StoredRow | null>;
  };
}

export interface UpsertGoogleIntegrationInput {
  userId: string;
  accountEmail: string;
  accessToken: string;
  /** Absent on a repeat consent that reuses an existing grant. */
  refreshToken?: string | null | undefined;
  /** Space-delimited, as OAuth transmits it and the column stores it. */
  scopes: string;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  /**
   * The granted scopes, split out of the stored string. Google names them as
   * full URLs, so callers test membership against a whole scope URL rather than
   * comparing the string to the set that was requested.
   */
  scopes: string[];
}

// One context per column, as `tokenCrypto` requires: a ciphertext only opens
// under the context it was written for, so a value moved between users or
// between these two columns fails authentication like a tampered one.
function accessTokenContext(userId: string): string {
  return `${userId}:accessToken`;
}

function refreshTokenContext(userId: string): string {
  return `${userId}:refreshToken`;
}

/**
 * Normalized exactly as the sign-in path normalizes the identity email, so the
 * address that keys the row is the address that keyed the `User` upsert — a
 * mixed-case `Chef@Mise.test` must not open a second integration for the
 * account already stored in lowercase.
 */
function normalizeAccountEmail(accountEmail: string): string {
  return accountEmail.trim().toLowerCase();
}

function splitScopes(scopes: string): string[] {
  return scopes.split(/\s+/).filter((scope) => scope !== "");
}

/**
 * Records this sign-in's credentials for a Google account, creating the row on
 * first consent and updating it on every later one — re-login never duplicates,
 * because the upsert is keyed on the composite unique.
 */
export async function upsertGoogleIntegration(
  input: UpsertGoogleIntegrationInput,
  client: IntegrationClient = prisma,
): Promise<void> {
  const { userId, scopes } = input;
  const accountEmail = normalizeAccountEmail(input.accountEmail);

  const accessTokenEnc = encrypt(input.accessToken, accessTokenContext(userId));
  // Trimmed before the emptiness test, and stored trimmed: whitespace is never
  // part of a token, so a response carrying only whitespace brought no refresh
  // token at all. Encrypting it would otherwise produce a valid-looking
  // ciphertext that the update below writes over the only copy of the grant.
  const refreshToken = input.refreshToken?.trim() ?? "";
  const refreshTokenEnc =
    refreshToken === ""
      ? undefined
      : encrypt(refreshToken, refreshTokenContext(userId));

  await client.integration.upsert({
    where: {
      userId_provider_accountEmail: {
        userId,
        provider: GOOGLE,
        accountEmail,
      },
    },
    create: {
      userId,
      provider: GOOGLE,
      accountEmail,
      accessTokenEnc,
      // The column is nullable, so a first consent that returned no refresh
      // token stores none rather than failing the sign-in; the next consent
      // with `prompt=consent` fills it in.
      refreshTokenEnc: refreshTokenEnc ?? null,
      scopes,
    },
    // `refreshTokenEnc` is omitted entirely when this sign-in brought no
    // refresh token: Google returns one only on the consent that creates the
    // grant, so writing null would destroy the only copy. Leaving the key out
    // keeps the stored value in the same statement that updates the rest —
    // no read-modify-write, so nothing to race.
    update: {
      accessTokenEnc,
      ...(refreshTokenEnc === undefined ? {} : { refreshTokenEnc }),
      scopes,
    },
    // Only the id comes back: the ciphertext has no reason to cross the wire
    // again, and `lastSyncedAt`/`label` belong to whoever sets them.
    select: { id: true },
  });
}

/**
 * The sanctioned read path for a stored Google credential: the only place the
 * ciphertext columns are decrypted. Returns null when the account has no row,
 * which is also what a lookup under the wrong `userId` gets.
 */
export async function getGoogleTokens(
  userId: string,
  accountEmail: string,
  client: IntegrationClient = prisma,
): Promise<GoogleTokens | null> {
  const row = await client.integration.findUnique({
    where: {
      userId_provider_accountEmail: {
        userId,
        provider: GOOGLE,
        accountEmail: normalizeAccountEmail(accountEmail),
      },
    },
    select: { accessTokenEnc: true, refreshTokenEnc: true, scopes: true },
  });

  if (row === null) {
    return null;
  }

  return {
    accessToken: decrypt(row.accessTokenEnc, accessTokenContext(userId)),
    refreshToken:
      row.refreshTokenEnc === null
        ? null
        : decrypt(row.refreshTokenEnc, refreshTokenContext(userId)),
    scopes: splitScopes(row.scopes),
  };
}
