// Lazy day rollover — the only module that advances `User.lastRolloverOn` or
// bumps `Task.deferCount`. Nothing schedules it: the first authenticated
// request of a new local day carries it (see `middleware/rollover.ts`), which
// is what "lazy" means here, and is also why a day the app was never opened
// leaves no trace. A week away costs one increment, not seven.
//
// Every statement carries the user: the zone read and the claim are keyed by
// `id`, the task update by `userId`, same rule as `services/tasks.ts`.
import { prisma } from "@mise/db";
import type { TaskStatus } from "@mise/shared";

/**
 * The statuses a rollover defers — the unfinished ones. `DONE` and `DROPPED`
 * are settled and keep the `deferCount` they ended with.
 */
const UNFINISHED_STATUSES = ["TODO", "IN_PROGRESS"] satisfies TaskStatus[];

/** Zone the "day" is measured in when the stored one is unusable. */
const DEFAULT_TIME_ZONE = "UTC";

/**
 * The local calendar day of `now` in `timeZone`, as the UTC midnight that
 * stands for it. A `@db.Date` column has no time and no zone, and Prisma reads
 * and writes it as the UTC midnight of that date — so "today" has to be built
 * that way to compare against the stored value.
 *
 * An unusable stored zone falls back to UTC rather than throwing: the column is
 * validated on the way in (`routes/settings.schema.ts`), so a value ICU rejects
 * here means the zone database moved under a row that was valid when written —
 * which must cost the user a day measured in the wrong zone, not every
 * authenticated request. The log follows the same rule: once per process, since
 * the condition persists until the column is rewritten and a line per request
 * would only bury it. The line names the column, never its value.
 */
function localDay(now: Date, timeZone: string): Date {
  return new Date(`${formatDay(now, timeZone)}T00:00:00.000Z`);
}

let warnedUnusableZone = false;

function formatDay(now: Date, timeZone: string): string {
  try {
    return dayFormat(timeZone).format(now);
  } catch {
    if (!warnedUnusableZone) {
      warnedUnusableZone = true;
      console.error(
        "[api] rollover: unusable User.timezone, measuring the day in UTC",
      );
    }

    return dayFormat(DEFAULT_TIME_ZONE).format(now);
  }
}

function dayFormat(timeZone: string): Intl.DateTimeFormat {
  // en-CA formats as YYYY-MM-DD, which is the shape `localDay` parses.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

interface FindTimeZoneArgs {
  where: { id: string };
  select: { timezone: true };
}

interface ClaimDayArgs {
  where: {
    id: string;
    AND: [{ OR: [{ lastRolloverOn: null }, { lastRolloverOn: { lt: Date } }] }];
  };
  data: { lastRolloverOn: Date };
}

interface DeferTasksArgs {
  where: { userId: string; status: { in: typeof UNFINISHED_STATUSES } };
  data: { deferCount: { increment: number } };
}

/**
 * The three statements the rollover issues, all inside its transaction.
 * Narrowed as in `services/tasks.ts` so a test can inject a double — an
 * interactive transaction double is just `$transaction: (run) => run(txDouble)`.
 */
export interface RolloverTransactionClient {
  user: {
    findUnique: (
      args: FindTimeZoneArgs,
    ) => Promise<{ timezone: string } | null>;
    updateMany: (args: ClaimDayArgs) => Promise<{ count: number }>;
  };
  task: {
    updateMany: (args: DeferTasksArgs) => Promise<{ count: number }>;
  };
}

export interface RolloverClient {
  $transaction: <T>(
    run: (tx: RolloverTransactionClient) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Rolls this user's unfinished tasks into the current local day, once.
 *
 * "Local" is the user's own `timezone` column, read inside the same transaction
 * as the claim so the day the claim writes is the day that zone was measured
 * in. A user row that is gone claims nothing: there is no zone to measure a day
 * in, and the session it came from is about to be useless anyway.
 *
 * The write order is the point. `updateMany` on the user row is the claim: its
 * `where` only matches while `lastRolloverOn` is still behind today, so under
 * READ COMMITTED a second concurrent request blocks on that row, re-reads the
 * committed value, and matches nothing — a count of 0 means someone else is
 * doing (or already did) today's rollover, and the tasks are left alone. Only
 * the request that moved the date increments, so two requests racing on the
 * first page load cannot double-count.
 *
 * The increment is a fixed 1 regardless of how many days elapsed: `deferCount`
 * answers "how many days did I push this?", and days the app was never opened
 * were never a day I pushed it.
 */
export async function rolloverIfNeeded(
  userId: string,
  now: Date,
  client: RolloverClient = prisma,
): Promise<void> {
  await client.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    if (user === null) {
      return;
    }

    const today = localDay(now, user.timezone);

    const { count } = await tx.user.updateMany({
      where: {
        id: userId,
        AND: [
          { OR: [{ lastRolloverOn: null }, { lastRolloverOn: { lt: today } }] },
        ],
      },
      data: { lastRolloverOn: today },
    });
    if (count === 0) {
      return;
    }

    await tx.task.updateMany({
      where: { userId, status: { in: UNFINISHED_STATUSES } },
      data: { deferCount: { increment: 1 } },
    });
  });
}
