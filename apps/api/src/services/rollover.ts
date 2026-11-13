// Lazy day rollover — the only module that advances `User.lastRolloverOn` or
// bumps `Task.deferCount`. Nothing schedules it: the first authenticated
// request of a new local day carries it (see `middleware/rollover.ts`), which
// is what "lazy" means here, and is also why a day the app was never opened
// leaves no trace. A week away costs one increment, not seven.
//
// Every statement carries the user: the claim is keyed by `id`, the task update
// by `userId`, same rule as `services/tasks.ts`.
import { prisma } from "@mise/db";
import type { TaskStatus } from "@mise/shared";

/**
 * The statuses a rollover defers — the unfinished ones. `DONE` and `DROPPED`
 * are settled and keep the `deferCount` they ended with.
 */
const UNFINISHED_STATUSES = ["TODO", "IN_PROGRESS"] satisfies TaskStatus[];

/** Zone the "day" is measured in when `USER_TZ` says nothing. */
const DEFAULT_TIME_ZONE = "UTC";

/**
 * The zone that decides when a day turns over, validated once at module load:
 * a typo in `USER_TZ` must stop the process at startup rather than throw a
 * `RangeError` out of the middleware on every request. The var is named without
 * its value, as in `env.ts`.
 */
const dayFormat = createDayFormat();

function createDayFormat(): Intl.DateTimeFormat {
  const timeZone = process.env.USER_TZ?.trim() ?? "";

  try {
    // en-CA formats as YYYY-MM-DD, which is the shape `localDay` parses.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone === "" ? DEFAULT_TIME_ZONE : timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new Error("Invalid IANA time zone in env var: USER_TZ");
  }
}

/**
 * The local calendar day of `now`, as the UTC midnight that stands for it. A
 * `@db.Date` column has no time and no zone, and Prisma reads and writes it as
 * the UTC midnight of that date — so "today" has to be built that way to
 * compare against the stored value.
 */
function localDay(now: Date): Date {
  return new Date(`${dayFormat.format(now)}T00:00:00.000Z`);
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
 * The two statements the rollover issues, both inside its transaction. Narrowed
 * as in `services/tasks.ts` so a test can inject a double — an interactive
 * transaction double is just `$transaction: (run) => run(txDouble)`.
 */
export interface RolloverTransactionClient {
  user: {
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
  const today = localDay(now);

  await client.$transaction(async (tx) => {
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
