/**
 * Mirrors `TimezoneSource` in `apps/db/prisma/schema.prisma` exactly. Same
 * hand-sync caveat as `TaskStatus` in `task.ts`: the web app has no path to the
 * Prisma client, so this union is kept in step with the enum by hand.
 */
export type TimezoneSource = "DETECTED" | "EXPLICIT";

/**
 * Body of `GET /api/settings` and of a successful `PATCH`. The zone is an IANA
 * name (`"America/Chicago"`, `"UTC"`), which is the only form the API accepts
 * or returns — never an offset, which would go stale across a DST change.
 *
 * `timezoneSource` is what the web app reads before offering its detected zone:
 * `EXPLICIT` means the user chose this one in settings and detection must leave
 * it alone.
 */
export interface Settings {
  timezone: string;
  timezoneSource: TimezoneSource;
}

/**
 * Payload for `PATCH /api/settings`. Only the zone: `timezoneSource` is set
 * server-side — any accepted write through this endpoint is by definition the
 * user choosing, so a client cannot claim one way or the other.
 */
export interface UpdateSettingsInput {
  timezone: string;
}

/**
 * Payload for `PATCH /api/settings/detected` — the browser's detected zone,
 * same field and same validation as the explicit write, kept a type of its own
 * because the endpoint means something else entirely: it stores the zone only
 * while `timezoneSource` is still `DETECTED` and leaves it `DETECTED`, so
 * detection can keep following the user around and can never claim their
 * explicit choice. A user who is already `EXPLICIT` is a silent no-op (`204`),
 * not an error, so the response carries nothing: the source cannot change, so
 * there is nothing for the client to learn from it.
 */
export interface DetectTimezoneInput {
  timezone: string;
}
