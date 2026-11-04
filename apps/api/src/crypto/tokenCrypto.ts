// AES-256-GCM encryption for OAuth tokens at rest. All encryption and
// decryption for stored secrets lives here — nothing else touches the key.
//
// Stored format: three base64 parts joined by dots, with no version prefix.
//
//   <iv>.<ciphertext>.<authTag>
//
// Every value is bound to a caller-supplied `context` string (e.g.
// `${userId}:${fieldName}`), passed as the GCM additional authenticated data.
// The context is required, is not stored, and must match on decrypt: a
// ciphertext moved to another user or another column fails authentication
// exactly like a tampered one.
//
// Invariants:
//   - exactly 3 dot-separated parts ("." is outside the base64 alphabet, so
//     splitting is unambiguous)
//   - iv decodes to exactly 12 bytes, freshly random per `encrypt` call
//   - authTag decodes to exactly 16 bytes
//   - ciphertext is the same length as the plaintext (GCM is a stream mode) and
//     may be empty when the plaintext is empty
//
// Nothing in this module logs, returns, or embeds key material, plaintext, or
// any part of a stored value in an error.
//
// Importing this module reads TOKEN_ENCRYPTION_KEY and then deletes it from
// `process.env` (see below), so an env validator must either read that var
// before this module is imported or tolerate its absence.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const KEY_REQUIREMENT =
  "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key " +
  "(generate: openssl rand -base64 32)";

// Fixed messages: neither ever interpolates an argument, so a bad call cannot
// put key material, plaintext, or a stored value into a log.
const INPUT_REQUIREMENT =
  "token encryption requires string plaintext and non-empty string context";
const DECRYPT_FAILURE = "token decryption failed";

function loadKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (raw === undefined || raw === "") {
    throw new Error(`${KEY_REQUIREMENT}; it is not set`);
  }

  const key = Buffer.from(raw, "base64");

  // Buffer.from(_, "base64") never throws: it skips characters outside the
  // alphabet and truncates a trailing partial group, so garbage decodes to
  // something. Re-encoding and comparing is what actually rejects malformed
  // input; the length check below is the real gate on key strength.
  if (key.toString("base64") !== raw) {
    throw new Error(`${KEY_REQUIREMENT}; it is not valid base64`);
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(`${KEY_REQUIREMENT}; it decodes to ${key.length} bytes`);
  }

  return key;
}

// Read and validate at module init so a bad key fails on startup, not on the
// first token write.
const key = loadKey();

// Drop the env copy once the key is in hand: anything that serializes the
// environment later (log shippers, crash reporters, `/debug` style handlers)
// then has nothing to leak, and this Buffer is the only copy in the process.
delete process.env.TOKEN_ENCRYPTION_KEY;

export function encrypt(plaintext: string, context: string): string {
  // Checked before the cipher so Node's own ERR_INVALID_ARG_TYPE — which
  // inlines the offending value into its message — can never fire here.
  if (
    typeof plaintext !== "string" ||
    typeof context !== "string" ||
    context.length === 0
  ) {
    throw new Error(INPUT_REQUIREMENT);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    iv.toString("base64"),
    ciphertext.toString("base64"),
    cipher.getAuthTag().toString("base64"),
  ].join(".");
}

export function decrypt(stored: string, context: string): string {
  // A missing or non-string argument is reported as the same opaque failure as
  // a wrong context: either way the value is unusable, and the caller gets one
  // error surface to handle.
  if (
    typeof stored !== "string" ||
    typeof context !== "string" ||
    context.length === 0
  ) {
    throw new Error(DECRYPT_FAILURE);
  }

  try {
    const parts = stored.split(".");
    if (parts.length !== 3) {
      throw new Error("malformed stored value");
    }

    // Length is checked above; the assertion only drops the `| undefined` that
    // noUncheckedIndexedAccess adds.
    const [ivPart, ciphertextPart, authTagPart] = parts as [
      string,
      string,
      string,
    ];

    const iv = Buffer.from(ivPart, "base64");
    const ciphertext = Buffer.from(ciphertextPart, "base64");
    const authTag = Buffer.from(authTagPart, "base64");

    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
      throw new Error("malformed stored value");
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return plaintext.toString("utf8");
  } catch {
    // Deliberately opaque: no `cause`, no original message, nothing from the
    // input. Callers only need to know the value is unusable.
    throw new Error(DECRYPT_FAILURE);
  }
}
