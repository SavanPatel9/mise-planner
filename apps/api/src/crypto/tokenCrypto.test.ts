import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// The encryption key is read once at module init, so every key scenario needs a
// fresh module instance. Tests deliberately never read a .env file, and never
// interpolate key or plaintext material into assertion messages.

type TokenCrypto = {
  encrypt: (plaintext: string, context: string) => string;
  decrypt: (stored: string, context: string) => string;
};

const KEY_VAR = "TOKEN_ENCRYPTION_KEY";
const DECRYPT_FAILURE = /token decryption failed/;
const INPUT_REQUIREMENT =
  /token encryption requires string plaintext and non-empty string context/;

// A realistic `${userId}:${fieldName}` AAD context, plus near-miss variants.
const CONTEXT = "user_01HQZ:googleRefreshToken";
const OTHER_FIELD = "user_01HQZ:googleAccessToken";
const OTHER_USER = "user_01HQX:googleRefreshToken";

function freshKey(): string {
  return randomBytes(32).toString("base64");
}

/** Re-imports the module with `key` installed (or removed when undefined). */
async function loadWithKey(key: string | undefined): Promise<TokenCrypto> {
  if (key === undefined) {
    delete process.env[KEY_VAR];
  } else {
    process.env[KEY_VAR] = key;
  }
  vi.resetModules();
  return await import("./tokenCrypto.js");
}

/** Splits a stored value, asserting the three-part `iv.ciphertext.authTag` shape. */
function splitStored(stored: string): [string, string, string] {
  const parts = stored.split(".");
  expect(parts).toHaveLength(3);
  return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""];
}

/** Flips one bit of a base64 part, keeping its decoded byte length identical. */
function flipBit(base64Part: string): string {
  const bytes = Buffer.from(base64Part, "base64");
  expect(bytes.byteLength).toBeGreaterThan(0);
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return bytes.toString("base64");
}

/**
 * Boolean, not an assertion, so a failure can never make vitest print the key.
 */
function mentionsSecret(message: string, secret: string): boolean {
  if (secret.length === 0) return false;
  return message.includes(secret);
}

// Captured once, at file load: the module deletes KEY_VAR from the environment
// as soon as it imports successfully, so a per-test `beforeEach` capture would
// read the already-scrubbed value and lose the ambient one for good. Every
// scenario installs its own key via `loadWithKey` before importing, so nothing
// depends on the ambient value surviving between tests.
const originalKey = process.env[KEY_VAR];

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env[KEY_VAR];
  } else {
    process.env[KEY_VAR] = originalKey;
  }
  vi.resetModules();
});

describe("tokenCrypto round trip", () => {
  it("decrypts what it encrypted", async () => {
    const crypto = await loadWithKey(freshKey());
    const plaintext = "ya29.a0ARrdaM-fake-refresh-token-value";

    expect(crypto.decrypt(crypto.encrypt(plaintext, CONTEXT), CONTEXT)).toBe(
      plaintext,
    );
  });

  it("round trips non-ASCII plaintext byte-for-byte", async () => {
    const crypto = await loadWithKey(freshKey());
    const plaintext = "mise — tout en place 🍳 ñ 日本語 \u0000 end";

    expect(crypto.decrypt(crypto.encrypt(plaintext, CONTEXT), CONTEXT)).toBe(
      plaintext,
    );
  });

  it("round trips plaintext containing the dot separator", async () => {
    const crypto = await loadWithKey(freshKey());
    const plaintext = "header.payload.signature";

    expect(crypto.decrypt(crypto.encrypt(plaintext, CONTEXT), CONTEXT)).toBe(
      plaintext,
    );
  });

  it("round trips an empty plaintext", async () => {
    const crypto = await loadWithKey(freshKey());

    expect(crypto.decrypt(crypto.encrypt("", CONTEXT), CONTEXT)).toBe("");
  });

  it("round trips a long plaintext", async () => {
    const crypto = await loadWithKey(freshKey());
    const plaintext = "t".repeat(4096);

    expect(crypto.decrypt(crypto.encrypt(plaintext, CONTEXT), CONTEXT)).toBe(
      plaintext,
    );
  });

  it("round trips across a re-import with the same key", async () => {
    const key = freshKey();
    const writer = await loadWithKey(key);
    const stored = writer.encrypt("stable-across-process-restart", CONTEXT);

    const reader = await loadWithKey(key);

    expect(reader.decrypt(stored, CONTEXT)).toBe(
      "stable-across-process-restart",
    );
  });
});

describe("tokenCrypto stored format", () => {
  it("emits bare iv.ciphertext.authTag with a 12-byte IV and 16-byte tag", async () => {
    const crypto = await loadWithKey(freshKey());

    const [iv, ciphertext, authTag] = splitStored(
      crypto.encrypt("format", CONTEXT),
    );

    expect(Buffer.from(iv, "base64").byteLength).toBe(12);
    expect(Buffer.from(authTag, "base64").byteLength).toBe(16);
    expect(Buffer.from(ciphertext, "base64").byteLength).toBe(
      Buffer.byteLength("format", "utf8"),
    );
    // No version prefix: the first part must itself be the IV.
    expect(iv).not.toMatch(/^v\d/i);
  });

  it("uses a fresh IV per encryption, so repeats never collide", async () => {
    const crypto = await loadWithKey(freshKey());
    const plaintext = "same-token-twice";

    const first = crypto.encrypt(plaintext, CONTEXT);
    const second = crypto.encrypt(plaintext, CONTEXT);

    expect(first).not.toBe(second);
    expect(splitStored(first)[0]).not.toBe(splitStored(second)[0]);
    expect(crypto.decrypt(first, CONTEXT)).toBe(plaintext);
    expect(crypto.decrypt(second, CONTEXT)).toBe(plaintext);
  });

  it("does not leak the plaintext into the stored value", async () => {
    const crypto = await loadWithKey(freshKey());
    const plaintext = "needle-should-not-appear";

    expect(mentionsSecret(crypto.encrypt(plaintext, CONTEXT), plaintext)).toBe(
      false,
    );
  });
});

describe("tokenCrypto tamper detection", () => {
  it("rejects a tampered IV", async () => {
    const crypto = await loadWithKey(freshKey());
    const [iv, ciphertext, authTag] = splitStored(
      crypto.encrypt("tampered-iv", CONTEXT),
    );

    expect(() =>
      crypto.decrypt([flipBit(iv), ciphertext, authTag].join("."), CONTEXT),
    ).toThrow(DECRYPT_FAILURE);
  });

  it("rejects a tampered ciphertext", async () => {
    const crypto = await loadWithKey(freshKey());
    const [iv, ciphertext, authTag] = splitStored(
      crypto.encrypt("tampered-ciphertext", CONTEXT),
    );

    expect(() =>
      crypto.decrypt([iv, flipBit(ciphertext), authTag].join("."), CONTEXT),
    ).toThrow(DECRYPT_FAILURE);
  });

  it("rejects a tampered auth tag", async () => {
    const crypto = await loadWithKey(freshKey());
    const [iv, ciphertext, authTag] = splitStored(
      crypto.encrypt("tampered-auth-tag", CONTEXT),
    );

    expect(() =>
      crypto.decrypt([iv, ciphertext, flipBit(authTag)].join("."), CONTEXT),
    ).toThrow(DECRYPT_FAILURE);
  });

  it("rejects parts swapped between two stored values", async () => {
    const crypto = await loadWithKey(freshKey());
    const [ivA, ciphertextA] = splitStored(crypto.encrypt("value-a", CONTEXT));
    const [, , authTagB] = splitStored(crypto.encrypt("value-b", CONTEXT));

    expect(() =>
      crypto.decrypt([ivA, ciphertextA, authTagB].join("."), CONTEXT),
    ).toThrow(DECRYPT_FAILURE);
  });

  it("rejects a value encrypted under a different key", async () => {
    const underKeyA = await loadWithKey(freshKey());
    const stored = underKeyA.encrypt("encrypted-with-key-a", CONTEXT);

    const underKeyB = await loadWithKey(freshKey());

    expect(() => underKeyB.decrypt(stored, CONTEXT)).toThrow(DECRYPT_FAILURE);
  });

  it("throws a plain Error whose message does not echo the stored value", async () => {
    const crypto = await loadWithKey(freshKey());
    const [iv, ciphertext, authTag] = splitStored(
      crypto.encrypt("opaque", CONTEXT),
    );
    const tampered = [iv, flipBit(ciphertext), authTag].join(".");

    let caught: unknown;
    try {
      crypto.decrypt(tampered, CONTEXT);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(DECRYPT_FAILURE);
    expect(mentionsSecret(message, tampered)).toBe(false);
    expect(mentionsSecret(message, ciphertext)).toBe(false);
  });
});

describe("tokenCrypto context binding", () => {
  it("round trips under the same context", async () => {
    const crypto = await loadWithKey(freshKey());
    const plaintext = "ya29.a0ARrdaM-fake-context-bound-token";

    const stored = crypto.encrypt(plaintext, CONTEXT);

    expect(crypto.decrypt(stored, CONTEXT)).toBe(plaintext);
  });

  it.each([
    ["a different field on the same user", OTHER_FIELD],
    ["the same field on a different user", OTHER_USER],
    ["a context differing only by a trailing space", `${CONTEXT} `],
    ["an empty context", ""],
  ])("refuses to decrypt under %s", async (_label, wrongContext) => {
    const crypto = await loadWithKey(freshKey());
    const stored = crypto.encrypt("bound-to-one-context", CONTEXT);

    expect(() => crypto.decrypt(stored, wrongContext)).toThrow(DECRYPT_FAILURE);
  });

  it("binds the context without storing it or changing the format", async () => {
    const crypto = await loadWithKey(freshKey());
    const plaintext = "format-unchanged";

    const stored = crypto.encrypt(plaintext, CONTEXT);
    const [iv, ciphertext, authTag] = splitStored(stored);

    expect(Buffer.from(iv, "base64").byteLength).toBe(12);
    expect(Buffer.from(authTag, "base64").byteLength).toBe(16);
    expect(Buffer.from(ciphertext, "base64").byteLength).toBe(
      Buffer.byteLength(plaintext, "utf8"),
    );
    expect(stored).not.toContain(CONTEXT);
  });
});

describe("tokenCrypto argument guards", () => {
  it("rejects an empty-string context on encrypt", async () => {
    const crypto = await loadWithKey(freshKey());

    expect(() => crypto.encrypt("needs-a-context", "")).toThrow(
      INPUT_REQUIREMENT,
    );
  });

  it.each<[label: string, context: unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["a number", 7],
  ])("rejects %s as the context on encrypt", async (_label, context) => {
    const crypto = await loadWithKey(freshKey());

    expect(() => crypto.encrypt("needs-a-context", context as string)).toThrow(
      INPUT_REQUIREMENT,
    );
  });

  // `rendered` is how the value would surface if Node's own
  // ERR_INVALID_ARG_TYPE (which inlines the received value) ever reached the
  // caller. Compared as a boolean so a failure cannot print it.
  it.each<[label: string, plaintext: unknown, rendered: string]>([
    ["undefined", undefined, "undefined"],
    ["null", null, "null"],
    ["a number", 424242, "424242"],
    ["an object", { token: "nested-token-shaped" }, "nested-token-shaped"],
    ["a Buffer", Buffer.from("buffered-token-shaped"), "buffered-token-shaped"],
  ])(
    "rejects %s as the plaintext without echoing it",
    async (_label, plaintext, rendered) => {
      const crypto = await loadWithKey(freshKey());

      let caught: unknown;
      try {
        crypto.encrypt(plaintext as string, CONTEXT);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toMatch(INPUT_REQUIREMENT);
      expect(message).not.toMatch(/ERR_INVALID_ARG_TYPE|must be of type/);
      expect(mentionsSecret(message, rendered)).toBe(false);
    },
  );

  // Pins the `typeof stored !== "string"` guard itself rather than the
  // try/catch behind it. A boxed String wrapping a *valid* stored value has a
  // working `.split`, so every check inside the try block passes and the
  // plaintext comes back out: deleting the guard turns this case into a silent
  // success that no other test can see.
  it("rejects a boxed String stored value that would otherwise decrypt", async () => {
    const crypto = await loadWithKey(freshKey());
    const plaintext = "boxed-string-must-not-decrypt";
    const boxed = new String(
      crypto.encrypt(plaintext, CONTEXT),
    ) as unknown as string;

    // Why the guard is the only thing standing between this value and the
    // plaintext: not a string, yet it splits into the three expected parts.
    expect(typeof boxed).not.toBe("string");
    expect(boxed.split(".")).toHaveLength(3);

    let caught: unknown;
    try {
      crypto.decrypt(boxed, CONTEXT);
    } catch (error) {
      caught = error;
    }

    // Asserted via `caught` so a regression reports "undefined" rather than
    // letting vitest print the recovered plaintext.
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(DECRYPT_FAILURE);
    expect(mentionsSecret(message, plaintext)).toBe(false);
  });

  it.each<[label: string, context: unknown]>([
    ["undefined", undefined],
    ["an empty string", ""],
    ["a number", 7],
  ])("rejects %s as the context on decrypt", async (_label, context) => {
    const crypto = await loadWithKey(freshKey());
    const stored = crypto.encrypt("needs-a-context", CONTEXT);

    expect(() => crypto.decrypt(stored, context as string)).toThrow(
      DECRYPT_FAILURE,
    );
  });
});

describe("tokenCrypto malformed input", () => {
  const malformed: Array<[label: string, build: (stored: string) => string]> = [
    ["an empty string", () => ""],
    ["a whitespace-only string", () => "   "],
    ["a single part", (stored) => splitStored(stored)[0]],
    [
      "two parts",
      (stored) => {
        const [iv, ciphertext] = splitStored(stored);
        return `${iv}.${ciphertext}`;
      },
    ],
    [
      "four parts",
      (stored) => {
        const [iv, ciphertext, authTag] = splitStored(stored);
        return [iv, ciphertext, authTag, authTag].join(".");
      },
    ],
    ["non-base64 garbage", () => "not base64!.still $not$ base64!.nope!"],
    [
      "a non-base64 ciphertext part alongside a valid IV and tag",
      (stored) => {
        const [iv, , authTag] = splitStored(stored);
        return [iv, "$$ not base64 $$", authTag].join(".");
      },
    ],
    [
      "a truncated IV",
      (stored) => {
        const [iv, ciphertext, authTag] = splitStored(stored);
        const short = Buffer.from(iv, "base64").subarray(0, 11);
        return [short.toString("base64"), ciphertext, authTag].join(".");
      },
    ],
    [
      "an over-long IV",
      (stored) => {
        const [iv, ciphertext, authTag] = splitStored(stored);
        const long = Buffer.concat([
          Buffer.from(iv, "base64"),
          Buffer.alloc(4),
        ]);
        return [long.toString("base64"), ciphertext, authTag].join(".");
      },
    ],
    [
      "a truncated auth tag",
      (stored) => {
        const [iv, ciphertext, authTag] = splitStored(stored);
        const short = Buffer.from(authTag, "base64").subarray(0, 15);
        return [iv, ciphertext, short.toString("base64")].join(".");
      },
    ],
    [
      "an empty IV part",
      (stored) => {
        const [, ciphertext, authTag] = splitStored(stored);
        return ["", ciphertext, authTag].join(".");
      },
    ],
    [
      "an empty auth tag part",
      (stored) => {
        const [iv, ciphertext] = splitStored(stored);
        return [iv, ciphertext, ""].join(".");
      },
    ],
  ];

  it.each(malformed)("throws on %s", async (_label, build) => {
    const crypto = await loadWithKey(freshKey());
    const candidate = build(crypto.encrypt("well-formed-source", CONTEXT));

    expect(() => crypto.decrypt(candidate, CONTEXT)).toThrow(DECRYPT_FAILURE);
  });
});

describe("tokenCrypto key validation at import", () => {
  it("rejects a missing key, naming the env var", async () => {
    await expect(loadWithKey(undefined)).rejects.toThrow(
      /TOKEN_ENCRYPTION_KEY/,
    );
  });

  it("rejects an empty key, naming the env var", async () => {
    await expect(loadWithKey("")).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it.each([
    ["a 16-byte key", () => randomBytes(16).toString("base64")],
    ["a 31-byte key", () => randomBytes(31).toString("base64")],
    ["a 33-byte key", () => randomBytes(33).toString("base64")],
    ["a hex-encoded 32-byte key", () => randomBytes(32).toString("hex")],
    ["a non-base64 key", () => "this is not base64 $$$ at all!"],
  ])("rejects %s without echoing it", async (_label, buildKey) => {
    const key = buildKey();

    let caught: unknown;
    try {
      await loadWithKey(key);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toMatch(/TOKEN_ENCRYPTION_KEY/);
    expect(mentionsSecret(error.message, key)).toBe(false);
    expect(mentionsSecret(String(error.stack ?? ""), key)).toBe(false);
  });

  it("accepts a well-formed 32-byte base64 key", async () => {
    await expect(loadWithKey(freshKey())).resolves.toMatchObject({
      encrypt: expect.any(Function),
      decrypt: expect.any(Function),
    });
  });

  it("scrubs the key from the environment once loaded", async () => {
    const crypto = await loadWithKey(freshKey());

    // Presence as a boolean, never the value: a failure must not print the key.
    expect(KEY_VAR in process.env).toBe(false);
    // The in-memory key still works after the env copy is gone.
    expect(
      crypto.decrypt(crypto.encrypt("still-works", CONTEXT), CONTEXT),
    ).toBe("still-works");
  });
});
