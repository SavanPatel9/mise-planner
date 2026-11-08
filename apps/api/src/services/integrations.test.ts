import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decrypt } from "../crypto/tokenCrypto.js";
import {
  getGoogleTokens,
  upsertGoogleIntegration,
  type IntegrationClient,
} from "./integrations.js";

// Prisma is mocked at the module boundary so importing the service never builds
// a real client: the default-client tests need the singleton to be observable,
// and no test may open a connection. The spies live outside the factory so they
// are the same functions the module captured at import.
const defaultDb = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@mise/db", () => ({
  prisma: {
    integration: { upsert: defaultDb.upsert, findUnique: defaultDb.findUnique },
  },
}));

// Fixture values only. Deliberately distinctive so a leak into a stored column
// or the console is unambiguous; never compared with `toContain`, which would
// print them on failure (see `mentions`).
const USER_ID = "user-cuid-3001";
const OTHER_USER_ID = "user-cuid-3002";
const EMAIL = "chef@mise.test";
/** The same address as Google may hand it over: padded and mixed case. */
const RAW_EMAIL = "  Chef@Mise.TEST ";
const OTHER_EMAIL = "second-kitchen@mise.test";
const ACCESS_TOKEN = "ya29.access-token-sentinel-6b4d";
const SECOND_ACCESS_TOKEN = "ya29.access-token-sentinel-7c5e";
const REFRESH_TOKEN = "1//refresh-token-sentinel-1a9f";
/** A token response that carries the field but nothing usable in it. */
const BLANK_REFRESH_TOKEN = "   ";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const SCOPE_STRING = `openid email profile ${CALENDAR_SCOPE}`;

const DECRYPT_FAILURE = /token decryption failed/;

/** The contexts the service must bind each column to, spelled out independently. */
function accessContext(userId: string): string {
  return `${userId}:accessToken`;
}

function refreshContext(userId: string): string {
  return `${userId}:refreshToken`;
}

// The statement shapes, derived from the exported client interface rather than
// restated, so a change to either `where` key fails to compile here.
type IntegrationApi = IntegrationClient["integration"];
type UpsertArgs = Parameters<IntegrationApi["upsert"]>[0];
type FindUniqueArgs = Parameters<IntegrationApi["findUnique"]>[0];
type StoredRow = NonNullable<Awaited<ReturnType<IntegrationApi["findUnique"]>>>;
type CompositeKey = UpsertArgs["where"]["userId_provider_accountEmail"];

/**
 * Boolean, not an assertion, so a failing leak check can never make vitest
 * print a token or a ciphertext.
 */
function mentions(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  return haystack.includes(needle);
}

/** A stored value that is encrypted: three-part format and no trace of the input. */
function isCiphertextOf(stored: unknown, plaintext: string): boolean {
  return (
    typeof stored === "string" &&
    stored.split(".").length === 3 &&
    !mentions(stored, plaintext)
  );
}

/**
 * A map key standing in for the composite unique. The separator is a character
 * no id, provider or address can contain, so two distinct keys can never
 * collide into one row - written as an escape, never as a literal control
 * character, which would make git treat this file as binary.
 */
function rowKey(key: CompositeKey): string {
  return [key.userId, key.provider, key.accountEmail].join("\u0000");
}

/**
 * An in-memory `Integration` table keyed on the composite unique, so "re-login
 * updates rather than duplicates" and "a missing refresh token does not clobber
 * the stored one" are observable facts about the store rather than assertions
 * about call arguments. The update is applied by spreading only the keys the
 * statement actually carries — which is what Prisma does, and the whole reason
 * the service omits `refreshTokenEnc` instead of sending null.
 */
function createFakeIntegrations() {
  const rows = new Map<string, StoredRow>();

  const upsert = vi.fn(async (args: UpsertArgs) => {
    const key = rowKey(args.where.userId_provider_accountEmail);
    const existing = rows.get(key);

    if (existing === undefined) {
      const { accessTokenEnc, refreshTokenEnc, scopes } = args.create;
      rows.set(key, { accessTokenEnc, refreshTokenEnc, scopes });
    } else {
      rows.set(key, { ...existing, ...args.update });
    }

    return { id: `integration-${String(rows.size)}` };
  });

  const findUnique = vi.fn(
    async (args: FindUniqueArgs) =>
      rows.get(rowKey(args.where.userId_provider_accountEmail)) ?? null,
  );

  return {
    client: { integration: { upsert, findUnique } } satisfies IntegrationClient,
    upsert,
    findUnique,
    rows,
    /** The row as the database holds it, by the key the service should have used. */
    row(userId = USER_ID, accountEmail = EMAIL): StoredRow {
      const stored = rows.get(
        rowKey({ userId, provider: "GOOGLE", accountEmail }),
      );
      expect(stored, "expected a stored integration row").toBeDefined();

      return stored as StoredRow;
    },
  };
}

type FakeIntegrations = ReturnType<typeof createFakeIntegrations>;

function upsertArgs(fake: FakeIntegrations, index = 0): UpsertArgs {
  const args = fake.upsert.mock.calls[index]?.[0];
  expect(args, "expected an upsert statement").toBeDefined();

  return args as UpsertArgs;
}

function findUniqueArgs(fake: FakeIntegrations, index = 0): FindUniqueArgs {
  const args = fake.findUnique.mock.calls[index]?.[0];
  expect(args, "expected a findUnique statement").toBeDefined();

  return args as FindUniqueArgs;
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

function baseInput(
  overrides: Partial<Parameters<typeof upsertGoogleIntegration>[0]> = {},
) {
  return {
    userId: USER_ID,
    accountEmail: EMAIL,
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    scopes: SCOPE_STRING,
    ...overrides,
  };
}

describe("upsertGoogleIntegration", () => {
  let fake: FakeIntegrations;

  beforeEach(() => {
    fake = createFakeIntegrations();
    defaultDb.upsert.mockReset();
    defaultDb.findUnique.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("encrypts both tokens on first consent and stores no plaintext", async () => {
    await upsertGoogleIntegration(baseInput(), fake.client);

    const row = fake.row();
    expect(isCiphertextOf(row.accessTokenEnc, ACCESS_TOKEN)).toBe(true);
    expect(isCiphertextOf(row.refreshTokenEnc, REFRESH_TOKEN)).toBe(true);
    // The round trip proves the ciphertext is the token and not, say, the
    // other column's value written twice.
    expect(decrypt(row.accessTokenEnc, accessContext(USER_ID))).toBe(
      ACCESS_TOKEN,
    );
    expect(
      decrypt(row.refreshTokenEnc as string, refreshContext(USER_ID)),
    ).toBe(REFRESH_TOKEN);
  });

  it("binds each ciphertext to its own user, so another user cannot open it", async () => {
    await upsertGoogleIntegration(baseInput(), fake.client);
    const row = fake.row();

    // Asserted both ways round, so an unscoped context (which would fail the
    // wrong-user read for the wrong reason) cannot satisfy this test.
    expect(decrypt(row.accessTokenEnc, accessContext(USER_ID))).toBe(
      ACCESS_TOKEN,
    );
    // A row copied between users (a restored backup, a bad backfill) fails
    // authentication exactly like a tampered one.
    expect(() =>
      decrypt(row.accessTokenEnc, accessContext(OTHER_USER_ID)),
    ).toThrow(DECRYPT_FAILURE);
    expect(() =>
      decrypt(row.refreshTokenEnc as string, refreshContext(OTHER_USER_ID)),
    ).toThrow(DECRYPT_FAILURE);
  });

  it("binds each ciphertext to its own column", async () => {
    await upsertGoogleIntegration(baseInput(), fake.client);
    const row = fake.row();

    // One context per column, so the two values are not interchangeable.
    expect(() => decrypt(row.accessTokenEnc, refreshContext(USER_ID))).toThrow(
      DECRYPT_FAILURE,
    );
    expect(() =>
      decrypt(row.refreshTokenEnc as string, accessContext(USER_ID)),
    ).toThrow(DECRYPT_FAILURE);
  });

  it("keys the write on userId, provider and account email", async () => {
    await upsertGoogleIntegration(baseInput(), fake.client);

    expect(fake.upsert).toHaveBeenCalledTimes(1);
    expect(upsertArgs(fake).where).toEqual({
      userId_provider_accountEmail: {
        userId: USER_ID,
        provider: "GOOGLE",
        accountEmail: EMAIL,
      },
    });
  });

  it("stores the granted scope string verbatim", async () => {
    await upsertGoogleIntegration(baseInput(), fake.client);

    expect(fake.row().scopes).toBe(SCOPE_STRING);
    expect(upsertArgs(fake).create.scopes).toBe(SCOPE_STRING);
    expect(upsertArgs(fake).update.scopes).toBe(SCOPE_STRING);
  });

  it("updates the one row on re-login instead of duplicating it", async () => {
    await upsertGoogleIntegration(baseInput(), fake.client);
    await upsertGoogleIntegration(
      baseInput({ accessToken: SECOND_ACCESS_TOKEN }),
      fake.client,
    );

    // One statement per sign-in, both on the same composite key — so the store
    // holds a single row and the second access token is the live one.
    expect(fake.upsert).toHaveBeenCalledTimes(2);
    expect(fake.rows.size).toBe(1);
    expect(upsertArgs(fake, 1).where).toEqual(upsertArgs(fake, 0).where);
    expect(decrypt(fake.row().accessTokenEnc, accessContext(USER_ID))).toBe(
      SECOND_ACCESS_TOKEN,
    );
  });

  it("keeps a second Google account on its own row", async () => {
    await upsertGoogleIntegration(baseInput(), fake.client);
    await upsertGoogleIntegration(
      baseInput({ accountEmail: OTHER_EMAIL }),
      fake.client,
    );

    // The composite unique is per account, not per user: a second address is a
    // second grant, not an overwrite of the first.
    expect(fake.rows.size).toBe(2);
  });

  it("re-encrypts on every sign-in rather than reusing a stored ciphertext", async () => {
    await upsertGoogleIntegration(baseInput(), fake.client);
    const first = fake.row().accessTokenEnc;

    await upsertGoogleIntegration(baseInput(), fake.client);

    // Same plaintext, fresh IV: an identical stored value would mean the
    // service cached or copied a ciphertext instead of encrypting.
    expect(fake.row().accessTokenEnc === first).toBe(false);
  });

  for (const [label, refreshToken] of [
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["only whitespace", BLANK_REFRESH_TOKEN],
  ] as const) {
    it(`omits refreshTokenEnc from the update when the sign-in brought ${label}`, async () => {
      await upsertGoogleIntegration(baseInput({ refreshToken }), fake.client);

      const { update } = upsertArgs(fake);
      // Absent, not null: Google returns a refresh token only on the consent
      // that creates the grant, so writing null would destroy the only copy.
      expect("refreshTokenEnc" in update).toBe(false);
      expect(sortedKeys(update)).toEqual(["accessTokenEnc", "scopes"]);
    });
  }

  it("leaves a previously stored refresh token readable after a re-consent without one", async () => {
    await upsertGoogleIntegration(baseInput(), fake.client);

    await upsertGoogleIntegration(
      baseInput({ accessToken: SECOND_ACCESS_TOKEN, refreshToken: undefined }),
      fake.client,
    );

    const tokens = await getGoogleTokens(USER_ID, EMAIL, fake.client);
    expect(tokens?.accessToken).toBe(SECOND_ACCESS_TOKEN);
    // Still the original, and still decryptable: the grant survives the
    // narrower sign-in.
    expect(tokens?.refreshToken).toBe(REFRESH_TOKEN);
  });

  it("leaves a previously stored refresh token readable after a re-consent that sent only whitespace", async () => {
    await upsertGoogleIntegration(baseInput(), fake.client);

    await upsertGoogleIntegration(
      baseInput({
        accessToken: SECOND_ACCESS_TOKEN,
        refreshToken: BLANK_REFRESH_TOKEN,
      }),
      fake.client,
    );

    const tokens = await getGoogleTokens(USER_ID, EMAIL, fake.client);
    expect(tokens?.accessToken).toBe(SECOND_ACCESS_TOKEN);
    // Encrypted whitespace would be a well-formed ciphertext holding nothing
    // usable, and the update would have written it over the grant.
    expect(tokens?.refreshToken).toBe(REFRESH_TOKEN);
  });

  it("creates the row with a null refresh token when the first consent brought only whitespace", async () => {
    await upsertGoogleIntegration(
      baseInput({ refreshToken: BLANK_REFRESH_TOKEN }),
      fake.client,
    );

    // Absent, not an encrypted blank: the next consent with a real token has
    // to be able to tell the two apart.
    expect(upsertArgs(fake).create.refreshTokenEnc).toBeNull();
    expect(fake.row().refreshTokenEnc).toBeNull();
    expect(
      (await getGoogleTokens(USER_ID, EMAIL, fake.client))?.refreshToken,
    ).toBeNull();
  });

  it("creates the row with a null refresh token when the first consent brought none", async () => {
    await upsertGoogleIntegration(
      baseInput({ refreshToken: undefined }),
      fake.client,
    );

    // Nullable column, so a first consent without one is stored rather than
    // failing the sign-in — but it is null, never an encrypted empty string.
    expect(upsertArgs(fake).create.refreshTokenEnc).toBeNull();
    expect(fake.row().refreshTokenEnc).toBeNull();
    expect(await getGoogleTokens(USER_ID, EMAIL, fake.client)).toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: null,
      scopes: SCOPE_STRING.split(" "),
    });
  });

  it("writes neither lastSyncedAt nor label, on create or on update", async () => {
    await upsertGoogleIntegration(baseInput(), fake.client);
    await upsertGoogleIntegration(baseInput(), fake.client);

    for (const index of [0, 1]) {
      const args = upsertArgs(fake, index);
      // Exact key sets: `lastSyncedAt` and `label` belong to whoever sets
      // them, and a stray column here would be silently overwritten per
      // sign-in.
      expect(sortedKeys(args.create)).toEqual([
        "accessTokenEnc",
        "accountEmail",
        "provider",
        "refreshTokenEnc",
        "scopes",
        "userId",
      ]);
      expect(sortedKeys(args.update)).toEqual([
        "accessTokenEnc",
        "refreshTokenEnc",
        "scopes",
      ]);
    }
  });

  it("selects only the id back, never a ciphertext column", async () => {
    await upsertGoogleIntegration(baseInput(), fake.client);

    expect(upsertArgs(fake).select).toEqual({ id: true });
  });

  it("normalizes a padded, mixed-case account email before keying the row", async () => {
    await upsertGoogleIntegration(
      baseInput({ accountEmail: RAW_EMAIL }),
      fake.client,
    );

    const args = upsertArgs(fake);
    expect(args.where.userId_provider_accountEmail.accountEmail).toBe(EMAIL);
    expect(args.create.accountEmail).toBe(EMAIL);
  });

  it("does not open a second row for the same address in another case", async () => {
    await upsertGoogleIntegration(baseInput(), fake.client);
    await upsertGoogleIntegration(
      baseInput({ accountEmail: RAW_EMAIL, accessToken: SECOND_ACCESS_TOKEN }),
      fake.client,
    );

    expect(fake.rows.size).toBe(1);
    expect(decrypt(fake.row().accessTokenEnc, accessContext(USER_ID))).toBe(
      SECOND_ACCESS_TOKEN,
    );
  });

  it("issues its statement on the shared client when none is passed", async () => {
    defaultDb.upsert.mockResolvedValue({ id: "integration-default" });

    await upsertGoogleIntegration(baseInput());

    // The default argument is the singleton: a service that built its own
    // client would leak a connection pool per call.
    expect(defaultDb.upsert).toHaveBeenCalledTimes(1);
    expect(fake.upsert).not.toHaveBeenCalled();
  });

  it("propagates a failing write instead of swallowing it", async () => {
    const failure = new Error("upsert failed");
    fake.upsert.mockRejectedValueOnce(failure);

    // Verify turns this into `token_persist_failed`; a resolved promise here
    // would sign the user in with no stored credentials.
    await expect(
      upsertGoogleIntegration(baseInput(), fake.client),
    ).rejects.toBe(failure);
  });
});

describe("getGoogleTokens", () => {
  let fake: FakeIntegrations;

  beforeEach(async () => {
    fake = createFakeIntegrations();
    defaultDb.upsert.mockReset();
    defaultDb.findUnique.mockReset();
    await upsertGoogleIntegration(baseInput(), fake.client);
    fake.findUnique.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decrypts both tokens and returns the scopes as full URLs", async () => {
    const tokens = await getGoogleTokens(USER_ID, EMAIL, fake.client);

    expect(tokens?.accessToken).toBe(ACCESS_TOKEN);
    expect(tokens?.refreshToken).toBe(REFRESH_TOKEN);
    // Split, not re-derived: callers test membership against a whole scope
    // URL, so the Calendar scope has to survive as one element.
    expect(tokens?.scopes).toEqual([
      "openid",
      "email",
      "profile",
      CALENDAR_SCOPE,
    ]);
    expect(tokens?.scopes).toContain(CALENDAR_SCOPE);
  });

  it("filters the read by userId, provider and account email", async () => {
    await getGoogleTokens(USER_ID, EMAIL, fake.client);

    expect(fake.findUnique).toHaveBeenCalledTimes(1);
    expect(findUniqueArgs(fake).where).toEqual({
      userId_provider_accountEmail: {
        userId: USER_ID,
        provider: "GOOGLE",
        accountEmail: EMAIL,
      },
    });
  });

  it("selects only the three columns it decrypts", async () => {
    await getGoogleTokens(USER_ID, EMAIL, fake.client);

    expect(findUniqueArgs(fake).select).toEqual({
      accessTokenEnc: true,
      refreshTokenEnc: true,
      scopes: true,
    });
  });

  it("returns null when the account has no row", async () => {
    expect(await getGoogleTokens(USER_ID, OTHER_EMAIL, fake.client)).toBeNull();
  });

  it("returns nothing for another user's stored account", async () => {
    const tokens = await getGoogleTokens(OTHER_USER_ID, EMAIL, fake.client);

    // The only row belongs to USER_ID, and the read is keyed on the asking
    // user — a cross-user read misses it rather than decrypting it.
    expect(tokens).toBeNull();
    expect(findUniqueArgs(fake).where.userId_provider_accountEmail.userId).toBe(
      OTHER_USER_ID,
    );
  });

  it("finds the row from a padded, mixed-case address", async () => {
    const tokens = await getGoogleTokens(USER_ID, RAW_EMAIL, fake.client);

    expect(
      findUniqueArgs(fake).where.userId_provider_accountEmail.accountEmail,
    ).toBe(EMAIL);
    expect(tokens?.accessToken).toBe(ACCESS_TOKEN);
  });

  it("returns a null refresh token rather than throwing when none is stored", async () => {
    const empty = createFakeIntegrations();
    await upsertGoogleIntegration(
      baseInput({ refreshToken: null }),
      empty.client,
    );

    const tokens = await getGoogleTokens(USER_ID, EMAIL, empty.client);

    expect(tokens?.refreshToken).toBeNull();
    expect(tokens?.accessToken).toBe(ACCESS_TOKEN);
  });

  it("reports a ciphertext it cannot open as a decryption failure", async () => {
    fake.findUnique.mockResolvedValueOnce({
      accessTokenEnc: "not-a-stored-value",
      refreshTokenEnc: null,
      scopes: SCOPE_STRING,
    });

    // A tampered or wrong-key column must not come back as a usable token.
    await expect(getGoogleTokens(USER_ID, EMAIL, fake.client)).rejects.toThrow(
      DECRYPT_FAILURE,
    );
  });

  it("collapses the whitespace of a padded scope string", async () => {
    const padded = createFakeIntegrations();
    await upsertGoogleIntegration(
      baseInput({ scopes: `  openid   email  ` }),
      padded.client,
    );

    const tokens = await getGoogleTokens(USER_ID, EMAIL, padded.client);

    // No empty members: callers iterate this list.
    expect(tokens?.scopes).toEqual(["openid", "email"]);
  });

  it("reads through the shared client when none is passed", async () => {
    defaultDb.findUnique.mockResolvedValue(null);

    expect(await getGoogleTokens(USER_ID, EMAIL)).toBeNull();

    expect(defaultDb.findUnique).toHaveBeenCalledTimes(1);
    expect(fake.findUnique).not.toHaveBeenCalled();
  });
});

describe("integration service logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes nothing to the console on any path", async () => {
    const fake = createFakeIntegrations();
    const spies = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    };

    await upsertGoogleIntegration(baseInput(), fake.client);
    await getGoogleTokens(USER_ID, EMAIL, fake.client);
    await getGoogleTokens(OTHER_USER_ID, EMAIL, fake.client);
    fake.upsert.mockRejectedValueOnce(new Error("upsert failed"));
    await upsertGoogleIntegration(baseInput(), fake.client).catch(() => {});

    // Every argument this module takes is a token or an address, so the bar is
    // silence rather than redaction.
    const calls = Object.values(spies).flatMap((spy) => spy.mock.calls);
    expect(calls).toHaveLength(0);

    const written = calls
      .flat()
      .map((entry) =>
        typeof entry === "string" ? entry : JSON.stringify(entry),
      )
      .join(" ");
    const row = fake.row();
    for (const secret of [
      ACCESS_TOKEN,
      REFRESH_TOKEN,
      EMAIL,
      row.accessTokenEnc,
      row.refreshTokenEnc ?? "",
    ]) {
      expect(mentions(written, secret)).toBe(false);
    }
  });
});
