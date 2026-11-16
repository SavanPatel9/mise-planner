// User settings — currently the one setting there is, the zone the day is
// measured in (`services/rollover.ts` reads the same column). The only module
// that writes `User.timezone` or `User.timezoneSource`.
//
// Every statement is keyed by `id: userId`: for `User` that *is* the user
// scope, which is why this module can use the unique-keyed `update` that
// `services/tasks.ts` deliberately avoids — there, `id` alone would address a
// row without naming its owner.
//
// Nothing leaves this module as a Prisma row: `toSettingsDto` maps the one
// `select` below onto the shared `Settings` DTO, so a column added to the model
// does not silently join the wire shape.
import { prisma } from "@mise/db";
import type {
  DetectTimezoneInput,
  Settings,
  TimezoneSource,
  UpdateSettingsInput,
} from "@mise/shared";

/**
 * The source the settings-screen write records. That write is the user choosing
 * their zone, which is precisely what detection must not overwrite afterwards
 * (`User.timezoneSource` in the schema). Checked against the shared union
 * rather than the generated Prisma enum, as in `services/tasks.ts`.
 */
const EXPLICIT = "EXPLICIT" satisfies TimezoneSource;

/**
 * The source a detected zone may be stored under — and the condition that lets
 * it be stored at all. It is both the `where` and the (implicit) `data` of
 * `applyDetectedTimezone`: detection reads and leaves `DETECTED`, so it can
 * keep following a travelling user without ever being mistaken for a choice.
 */
const DETECTED = "DETECTED" satisfies TimezoneSource;

/**
 * The columns both statements select: exactly the fields of the shared
 * `Settings` DTO, no more. `satisfies Record<keyof Settings, true>` is the
 * guard — a field added to the DTO fails to compile here until it is selected.
 */
const SETTINGS_SELECT = {
  timezone: true,
  timezoneSource: true,
} satisfies Record<keyof Settings, true>;

type SettingsSelect = typeof SETTINGS_SELECT;

/** A row as `SETTINGS_SELECT` returns it — the DTO carries no `Date`s. */
type SettingsRow = Settings;

interface FindSettingsArgs {
  where: { id: string };
  select: SettingsSelect;
}

interface UpdateSettingsArgs {
  where: { id: string };
  data: { timezone: string; timezoneSource: typeof EXPLICIT };
  select: SettingsSelect;
}

/**
 * The conditional write. `timezoneSource` in the `where` is the whole
 * mechanism, which is why this is an `updateMany` rather than the `update` the
 * read and the explicit write use: a unique-keyed `update` takes no condition
 * beyond the key, and checking the source in a query first would leave a window
 * for an explicit save to land between the two statements. `data` names only
 * the zone — the source is not written, so it stays `DETECTED` by not moving.
 */
interface DetectTimezoneArgs {
  where: { id: string; timezoneSource: typeof DETECTED };
  data: { timezone: string };
}

/**
 * The slice of the Prisma client used here, narrowed to the three statements
 * this module issues so a test can pass a double instead of a database. The
 * shared singleton is the default argument; nothing here constructs a client.
 */
export interface SettingsClient {
  user: {
    findUnique: (args: FindSettingsArgs) => Promise<SettingsRow | null>;
    update: (args: UpdateSettingsArgs) => Promise<SettingsRow>;
    updateMany: (args: DetectTimezoneArgs) => Promise<{ count: number }>;
  };
}

/**
 * Every function here runs below `requireAuth`, so Passport's
 * `deserializeUser` has already found this user's row in the same request. Its
 * absence here is a bug or an out-of-band deletion, not a client error: it
 * raises and surfaces as a 500 rather than a 404 nobody could act on. (The
 * explicit write leans on Prisma for the same outcome — an `update` that
 * matches nothing throws `P2025`.) The message names no user.
 *
 * `applyDetectedTimezone` is the exception, deliberately: a count of 0 there
 * cannot tell a missing row from an explicit choice, and both are the same
 * no-op for detection.
 */
function missingUserRow(): Error {
  return new Error("settings: the session's user row is gone");
}

/** Field by field, never a spread: the DTO is the contract, not the row. */
function toSettingsDto(row: SettingsRow): Settings {
  return {
    timezone: row.timezone,
    timezoneSource: row.timezoneSource,
  };
}

/** This user's settings. */
export async function getSettings(
  userId: string,
  client: SettingsClient = prisma,
): Promise<Settings> {
  const row = await client.user.findUnique({
    where: { id: userId },
    select: SETTINGS_SELECT,
  });
  if (row === null) {
    throw missingUserRow();
  }

  return toSettingsDto(row);
}

/**
 * Stores a zone the user chose and returns the settings as stored. The zone
 * itself is already validated by `routes/settings.schema.ts`; what this adds is
 * `timezoneSource`, which the client has no way to set.
 */
export async function updateSettings(
  userId: string,
  input: UpdateSettingsInput,
  client: SettingsClient = prisma,
): Promise<Settings> {
  const row = await client.user.update({
    where: { id: userId },
    data: { timezone: input.timezone, timezoneSource: EXPLICIT },
    select: SETTINGS_SELECT,
  });

  return toSettingsDto(row);
}

/**
 * Stores a zone the browser detected, but only while the user has not chosen
 * one. The condition lives in the statement rather than around it, so this is
 * race-safe by construction: a concurrent explicit save either commits first
 * and this matches nothing, or commits second and overwrites this — and either
 * order leaves the user's own choice standing.
 *
 * Nothing comes back. A count of 0 is the ordinary case for a user who has been
 * to settings, not a failure, and the source this stores is the source it
 * required, so there is nothing the caller could learn from the result that it
 * did not already send. Idempotent: re-running it with the same zone is a write
 * of the value already there.
 */
export async function applyDetectedTimezone(
  userId: string,
  input: DetectTimezoneInput,
  client: SettingsClient = prisma,
): Promise<void> {
  await client.user.updateMany({
    where: { id: userId, timezoneSource: DETECTED },
    data: { timezone: input.timezone },
  });
}
