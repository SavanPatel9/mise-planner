import { afterEach, describe, expect, it, vi } from "vitest";

import { isAllowed } from "./allowlist.js";

// Fixture addresses only — never a real inbox, and nothing here is logged.
const ALLOWED = "chef@mise.test";
const OTHER_ALLOWED = "sous@mise.test";
const STRANGER = "stranger@elsewhere.test";

describe("isAllowed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("admits an address listed in ALLOWED_EMAILS", () => {
    vi.stubEnv("ALLOWED_EMAILS", `${ALLOWED},${OTHER_ALLOWED}`);

    expect(isAllowed(ALLOWED)).toBe(true);
    expect(isAllowed(OTHER_ALLOWED)).toBe(true);
  });

  it("rejects an address that is not listed", () => {
    vi.stubEnv("ALLOWED_EMAILS", `${ALLOWED},${OTHER_ALLOWED}`);

    expect(isAllowed(STRANGER)).toBe(false);
  });

  it("rejects everyone when ALLOWED_EMAILS is missing", () => {
    vi.stubEnv("ALLOWED_EMAILS", undefined);

    // Fail safe: an unconfigured allowlist must not become an open door.
    expect(isAllowed(ALLOWED)).toBe(false);
    expect(isAllowed(STRANGER)).toBe(false);
    expect(isAllowed("")).toBe(false);
  });

  it("rejects everyone when ALLOWED_EMAILS is empty", () => {
    vi.stubEnv("ALLOWED_EMAILS", "");

    expect(isAllowed(ALLOWED)).toBe(false);
    expect(isAllowed("")).toBe(false);
  });

  it("rejects everyone when ALLOWED_EMAILS holds only separators or whitespace", () => {
    vi.stubEnv("ALLOWED_EMAILS", "   \t ");
    expect(isAllowed(ALLOWED)).toBe(false);

    vi.stubEnv("ALLOWED_EMAILS", " , ,, ");
    expect(isAllowed(ALLOWED)).toBe(false);
    expect(isAllowed("")).toBe(false);
    expect(isAllowed(" ")).toBe(false);
  });

  it("ignores whitespace around the listed entries", () => {
    vi.stubEnv("ALLOWED_EMAILS", `  ${ALLOWED} , ${OTHER_ALLOWED} `);

    expect(isAllowed(ALLOWED)).toBe(true);
    expect(isAllowed(OTHER_ALLOWED)).toBe(true);
  });

  it("ignores whitespace around the address under test", () => {
    vi.stubEnv("ALLOWED_EMAILS", ALLOWED);

    expect(isAllowed(`  ${ALLOWED}  `)).toBe(true);
  });

  it("matches case-insensitively in both directions", () => {
    vi.stubEnv("ALLOWED_EMAILS", "Chef@Mise.TEST");
    expect(isAllowed(ALLOWED)).toBe(true);
    expect(isAllowed("CHEF@MISE.TEST")).toBe(true);

    vi.stubEnv("ALLOWED_EMAILS", ALLOWED);
    expect(isAllowed("ChEf@MiSe.TeSt")).toBe(true);
  });

  it("does not turn trailing or doubled commas into a phantom entry", () => {
    vi.stubEnv("ALLOWED_EMAILS", `${ALLOWED},,${OTHER_ALLOWED},`);

    expect(isAllowed(ALLOWED)).toBe(true);
    expect(isAllowed(OTHER_ALLOWED)).toBe(true);
    // An empty-string caller must never collide with an empty list entry.
    expect(isAllowed("")).toBe(false);
    expect(isAllowed("   ")).toBe(false);
  });

  it("requires a whole-address match, not a substring", () => {
    vi.stubEnv("ALLOWED_EMAILS", ALLOWED);

    expect(isAllowed(`x${ALLOWED}`)).toBe(false);
    expect(isAllowed(`${ALLOWED}.evil.test`)).toBe(false);
    expect(isAllowed("chef@mise.tes")).toBe(false);
    expect(isAllowed("chef")).toBe(false);
  });

  it("re-reads ALLOWED_EMAILS on every call", () => {
    vi.stubEnv("ALLOWED_EMAILS", ALLOWED);
    expect(isAllowed(ALLOWED)).toBe(true);
    expect(isAllowed(OTHER_ALLOWED)).toBe(false);

    // Revoking access must take effect without reloading the module.
    vi.stubEnv("ALLOWED_EMAILS", OTHER_ALLOWED);
    expect(isAllowed(ALLOWED)).toBe(false);
    expect(isAllowed(OTHER_ALLOWED)).toBe(true);

    vi.stubEnv("ALLOWED_EMAILS", "");
    expect(isAllowed(ALLOWED)).toBe(false);
    expect(isAllowed(OTHER_ALLOWED)).toBe(false);
  });
});
