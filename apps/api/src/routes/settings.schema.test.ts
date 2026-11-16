import { describe, expect, it } from "vitest";

import {
  detectTimezoneSchema,
  updateSettingsSchema,
} from "./settings.schema.js";

describe("updateSettingsSchema", () => {
  // The names the picker will actually send, plus the two the max-length
  // comment is written against: the longest canonical zone and the longest
  // alias. If ICU ever drops one of these, this is where it surfaces — rather
  // than as a 400 on a zone the user picked from a list we generated.
  it.each([
    "UTC",
    "America/Chicago",
    "Asia/Tokyo",
    "Europe/London",
    "Pacific/Kiritimati",
    "America/Argentina/Rio_Gallegos",
    "America/Argentina/ComodRivadavia",
  ])("accepts the IANA zone %j", (timezone) => {
    const result = updateSettingsSchema.safeParse({ timezone });

    expect(result.success).toBe(true);
    // Exactly the one field, and verbatim: the service writes what this parsed.
    expect(result.data).toEqual({ timezone });
  });

  it("trims the zone before it reaches the column", () => {
    const result = updateSettingsSchema.safeParse({
      timezone: "  America/Chicago  ",
    });

    expect(result.success).toBe(true);
    expect(result.data?.timezone).toBe("America/Chicago");
  });

  it.each([
    "Mars/Olympus_Mons",
    "Etc/Nowhere",
    "America/Chicago/Loop",
    "America Chicago",
    "not-a-zone",
  ])("rejects %j as an unknown zone", (timezone) => {
    const result = updateSettingsSchema.safeParse({ timezone });

    expect(result.success).toBe(false);
    if (!result.success) {
      // Filed against the field, which is what makes the 400 carry
      // `fields.timezone` rather than a root-level message.
      expect(result.error.issues[0]?.path).toEqual(["timezone"]);
    }
  });

  it("rejects an empty zone", () => {
    const result = updateSettingsSchema.safeParse({ timezone: "" });

    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only zone rather than storing it trimmed to nothing", () => {
    const result = updateSettingsSchema.safeParse({ timezone: "   " });

    expect(result.success).toBe(false);
  });

  it("rejects a zone over the max length on length alone", () => {
    const result = updateSettingsSchema.safeParse({
      timezone: "a".repeat(65),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      // The length check is what must catch it: a pasted document is refused
      // without the zone lookup ever seeing it.
      expect(
        result.error.issues.some((issue) => issue.code === "too_big"),
      ).toBe(true);
    }
  });

  it("rejects a long zone-shaped string that is still a valid prefix", () => {
    const result = updateSettingsSchema.safeParse({
      timezone: `America/Chicago${"x".repeat(60)}`,
    });

    expect(result.success).toBe(false);
  });

  it.each([null, undefined, 42, true, {}, ["America/Chicago"]])(
    "rejects a non-string timezone (%j)",
    (timezone) => {
      const result = updateSettingsSchema.safeParse({ timezone });

      expect(result.success).toBe(false);
    },
  );

  it("rejects a body that names no field", () => {
    const result = updateSettingsSchema.safeParse({});

    expect(result.success).toBe(false);
    if (!result.success) {
      // The field is required, so the issue is the field's — not the whole
      // object's, the way `updateTaskSchema`'s empty-object check is.
      expect(result.error.issues[0]?.path).toEqual(["timezone"]);
    }
  });

  it("rejects a body that is not an object at all", () => {
    const result = updateSettingsSchema.safeParse("America/Chicago");

    expect(result.success).toBe(false);
    if (!result.success) {
      // Empty path — the validate middleware reports this under `_root`.
      expect(result.error.issues[0]?.path).toEqual([]);
    }
  });

  it("rejects an unknown field", () => {
    const result = updateSettingsSchema.safeParse({
      timezone: "America/Chicago",
      notAField: "oops",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.code === "unrecognized_keys"),
      ).toBe(true);
    }
  });

  it("rejects a client-sent timezoneSource — the server decides it", () => {
    const result = updateSettingsSchema.safeParse({
      timezone: "America/Chicago",
      timezoneSource: "DETECTED",
    });

    // Not silently dropped: a client that thinks it set the source would
    // otherwise be told `EXPLICIT` by a response it never asked for.
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.code === "unrecognized_keys" &&
            issue.keys.includes("timezoneSource"),
        ),
      ).toBe(true);
    }
  });

  // The three things ICU accepts that an IANA-name check arguably should not.
  // All three are accepted as-is, deliberately (see the note in
  // `settings.schema.ts`), and this pins that choice down so it changes on
  // purpose rather than by accident:
  //
  //  - a UTC offset still yields a correct day boundary, but a frozen one —
  //    the zone is what the picker sends, so this is a flagged gap, not a
  //    supported input. `Settings.timezone` in `packages/shared` documents the
  //    wire value as an IANA name;
  //  - a differently-cased name resolves to the canonical zone, and is stored
  //    in the casing the client sent rather than canonicalized;
  //  - a legacy POSIX-style alias likewise.
  it.each(["+05:00", "-08:00", "+0530", "america/chicago", "EST5EDT", "GMT"])(
    "accepts %j — ICU resolves it; known gap, stored verbatim",
    (timezone) => {
      const result = updateSettingsSchema.safeParse({ timezone });

      expect(result.success).toBe(true);
      expect(result.data?.timezone).toBe(timezone);
    },
  );
});

describe("detectTimezoneSchema", () => {
  // The detection body is the same one field. What it is *for* differs — the
  // browser offering a zone rather than the user choosing one — but a name ICU
  // cannot resolve must be a 400 whichever endpoint it arrives at, since
  // `services/rollover.ts` will measure a day in whatever got stored. The
  // cases above cover the zone rules exhaustively; these pin the detection
  // schema to the same answers.
  it.each([
    "UTC",
    "America/Chicago",
    "Pacific/Kiritimati",
    "America/Argentina/ComodRivadavia",
  ])("accepts the IANA zone %j", (timezone) => {
    const result = detectTimezoneSchema.safeParse({ timezone });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ timezone });
  });

  it("trims the zone before it reaches the column", () => {
    const result = detectTimezoneSchema.safeParse({
      timezone: "  America/Chicago  ",
    });

    expect(result.success).toBe(true);
    expect(result.data?.timezone).toBe("America/Chicago");
  });

  it.each(["Mars/Olympus_Mons", "not-a-zone", "", "   "])(
    "rejects %j as a zone",
    (timezone) => {
      const result = detectTimezoneSchema.safeParse({ timezone });

      expect(result.success).toBe(false);
    },
  );

  it("rejects a zone over the max length on length alone", () => {
    const result = detectTimezoneSchema.safeParse({ timezone: "a".repeat(65) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.code === "too_big"),
      ).toBe(true);
    }
  });

  it.each([null, undefined, 42, true, {}, ["America/Chicago"]])(
    "rejects a non-string timezone (%j)",
    (timezone) => {
      const result = detectTimezoneSchema.safeParse({ timezone });

      expect(result.success).toBe(false);
    },
  );

  it("rejects a body that names no field", () => {
    const result = detectTimezoneSchema.safeParse({});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["timezone"]);
    }
  });

  it("rejects an unknown field", () => {
    const result = detectTimezoneSchema.safeParse({
      timezone: "America/Chicago",
      notAField: "oops",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a client-sent timezoneSource — the endpoint decides it", () => {
    const result = detectTimezoneSchema.safeParse({
      timezone: "America/Chicago",
      timezoneSource: "DETECTED",
    });

    // Refused even though `DETECTED` is the only source this endpoint's
    // statement can leave behind: the source is never a field a client sends,
    // and accepting it here would read as though it were negotiable.
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.code === "unrecognized_keys" &&
            issue.keys.includes("timezoneSource"),
        ),
      ).toBe(true);
    }
  });

  // Two schemas, deliberately separate so each endpoint's body can evolve on
  // its own — but a zone one of them accepts and the other refuses would be a
  // bug whichever way round it fell. This is the guard on that drift for as
  // long as both bodies are the one field.
  it.each([
    { timezone: "America/Chicago" },
    { timezone: "  UTC  " },
    { timezone: "+05:00" },
    { timezone: "Mars/Olympus_Mons" },
    { timezone: "" },
    { timezone: 42 },
    {},
    { timezone: "UTC", timezoneSource: "EXPLICIT" },
  ])("agrees with updateSettingsSchema on %j", (body) => {
    const detected = detectTimezoneSchema.safeParse(body);
    const explicit = updateSettingsSchema.safeParse(body);

    expect(detected.success).toBe(explicit.success);
    expect(detected.data).toEqual(explicit.data);
  });
});
