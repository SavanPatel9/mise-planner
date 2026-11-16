// Request validation for the settings endpoints. `.strictObject` as
// everywhere, so an unknown field is a 400 rather than a silently-dropped typo;
// the `AssertAssignable` guards at the bottom are the compile-time half of the
// contract, exactly as in `tasks.schema.ts`.
import type { DetectTimezoneInput, UpdateSettingsInput } from "@mise/shared";
import { z } from "zod";

/**
 * Long enough for every zone name ICU accepts — the longest canonical one is
 * `America/Argentina/Rio_Gallegos` (30 characters) and the longest alias
 * `America/Argentina/ComodRivadavia` (32) — with room to spare, and short
 * enough that a pasted document never reaches the column.
 */
const TIMEZONE_MAX_LENGTH = 64;

function isResolvableTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });

    return true;
  } catch {
    return false;
  }
}

/**
 * A zone this process can actually measure a day in. The check is the runtime
 * itself rather than a hand-kept list: ICU owns the zone database, so asking
 * `Intl.DateTimeFormat` to accept the name is the only test that agrees with
 * what `services/rollover.ts` will later do with it. A `RangeError` is how ICU
 * reports an unknown zone, which here becomes a schema failure — and so a 400
 * through the validate middleware — rather than a 500 on the next rollover.
 *
 * Trimmed and non-empty first, as in `tasks.schema.ts`, since `""` and `"   "`
 * are both `RangeError`s anyway and read better as the empty-string failure.
 *
 * Two things this deliberately does not do: it does not canonicalize (ICU
 * resolves `"america/chicago"` and the legacy `"EST5EDT"` to their canonical
 * names, but what the user sent is what gets stored), and it does not reject
 * the offset forms ICU also accepts (`"+05:00"`). Both still produce a correct
 * day boundary; an offset's is simply frozen across a DST change.
 */
const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(TIMEZONE_MAX_LENGTH)
  .refine(isResolvableTimeZone, { message: "Unknown IANA time zone" });

export const updateSettingsSchema = z.strictObject({
  timezone: timezoneSchema,
});

/**
 * The detected zone, validated exactly as the explicit one: a zone this process
 * cannot measure a day in is a 400 whoever sent it. A schema of its own rather
 * than a reuse of `updateSettingsSchema`, because the two endpoints are two
 * contracts — the drift guards below pin each to its own shared type, and
 * either body may grow a field the other must not accept.
 */
export const detectTimezoneSchema = z.strictObject({
  timezone: timezoneSchema,
});

export type UpdateSettingsRequest = z.infer<typeof updateSettingsSchema>;

export type DetectTimezoneRequest = z.infer<typeof detectTimezoneSchema>;

/** See the note on `AssertAssignable` in `tasks.schema.ts`. */
type AssertAssignable<T extends U, U> = T;

export type _UpdateSettingsDriftGuard = [
  AssertAssignable<UpdateSettingsRequest, UpdateSettingsInput>,
  AssertAssignable<UpdateSettingsInput, UpdateSettingsRequest>,
  AssertAssignable<keyof UpdateSettingsRequest, keyof UpdateSettingsInput>,
  AssertAssignable<keyof UpdateSettingsInput, keyof UpdateSettingsRequest>,
];

export type _DetectTimezoneDriftGuard = [
  AssertAssignable<DetectTimezoneRequest, DetectTimezoneInput>,
  AssertAssignable<DetectTimezoneInput, DetectTimezoneRequest>,
  AssertAssignable<keyof DetectTimezoneRequest, keyof DetectTimezoneInput>,
  AssertAssignable<keyof DetectTimezoneInput, keyof DetectTimezoneRequest>,
];
