import { afterEach, describe, expect, it, vi } from "vitest";

// Prisma is mocked at the module boundary so loading the service never builds a
// real client. Every test passes its own double as the `client` argument, so
// this stand-in is only ever the *unused* default — `$transaction` is armed to
// reject precisely so a statement that reached for it fails loudly instead of
// being quietly answered. The spy lives outside the factory (`vi.hoisted`) so
// it survives the `vi.resetModules()` each load does.
const db = vi.hoisted(() => ({
  transaction: vi.fn(() =>
    Promise.reject(new Error("the default client must not be used")),
  ),
}));

vi.mock("@mise/db", () => ({
  prisma: {
    user: { findUnique: db.transaction, updateMany: db.transaction },
    task: { updateMany: db.transaction },
    $transaction: db.transaction,
  },
}));

import type { TaskStatus } from "@mise/shared";

import type { RolloverClient, RolloverTransactionClient } from "./rollover.js";

const USER_ID = "user-cuid-m3t3";
/** A second user, present in the fake task table and never to be touched. */
const OTHER_USER_ID = "user-cuid-m3t3-other";

/** The three statement shapes, read off the service's own narrowed interface. */
type ReadArgs = Parameters<RolloverTransactionClient["user"]["findUnique"]>[0];
type ClaimArgs = Parameters<RolloverTransactionClient["user"]["updateMany"]>[0];
type DeferArgs = Parameters<RolloverTransactionClient["task"]["updateMany"]>[0];

/**
 * The UTC midnight that stands for a calendar date, which is how Prisma reads
 * and writes a `@db.Date` column — so it is also what the claim must compare
 * against and write.
 */
function day(date: `${number}-${number}-${number}`): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

interface UserRow {
  id: string;
  /** The stored zone the rollover now reads instead of an env var. */
  timezone: string;
  lastRolloverOn: Date | null;
}

interface TaskRow {
  id: string;
  userId: string;
  status: TaskStatus;
  deferCount: number;
}

/**
 * The fake task table: both unfinished statuses, both settled ones, and one row
 * of another user's. Returned fresh per test because the double mutates it.
 */
function taskTable(): TaskRow[] {
  return [
    { id: "task-todo", userId: USER_ID, status: "TODO", deferCount: 0 },
    {
      id: "task-in-progress",
      userId: USER_ID,
      status: "IN_PROGRESS",
      deferCount: 3,
    },
    { id: "task-done", userId: USER_ID, status: "DONE", deferCount: 1 },
    { id: "task-dropped", userId: USER_ID, status: "DROPPED", deferCount: 2 },
    { id: "task-other", userId: OTHER_USER_ID, status: "TODO", deferCount: 0 },
  ];
}

function taskById(tasks: TaskRow[], id: string): TaskRow {
  const row = tasks.find((task) => task.id === id);
  expect(row, `expected a ${id} row`).toBeDefined();

  return row as TaskRow;
}

/**
 * Evaluates the claim's `where` against a stored row, rather than comparing it
 * to a literal — so what the assertions below rest on is that the condition
 * *selects* the right rows: a null `lastRolloverOn` matches, a date behind today
 * matches, today's own date does not.
 */
function claimMatches(where: ClaimArgs["where"], row: UserRow): boolean {
  if (where.id !== row.id) {
    return false;
  }

  return where.AND.every((and) =>
    and.OR.some((branch) => {
      const condition = branch.lastRolloverOn;
      if (condition === null) {
        return row.lastRolloverOn === null;
      }

      return (
        row.lastRolloverOn !== null &&
        row.lastRolloverOn.getTime() < condition.lt.getTime()
      );
    }),
  );
}

/** Applies a defer statement to the fake table and reports the rows it hit. */
function applyDefer(args: DeferArgs, tasks: TaskRow[]): number {
  const matched = tasks.filter(
    (task) =>
      task.userId === args.where.userId &&
      args.where.status.in.some((status) => status === task.status),
  );

  for (const task of matched) {
    task.deferCount += args.data.deferCount.increment;
  }

  return matched.length;
}

/** One recorded statement: its arguments and the client it ran on. */
interface Recorded<A> {
  args: A;
  tx: RolloverTransactionClient;
}

interface Harness {
  client: RolloverClient;
  user: UserRow;
  tasks: TaskRow[];
  /** The zone read each transaction opens with. */
  reads: Recorded<ReadArgs>[];
  claims: Recorded<ClaimArgs>[];
  defers: Recorded<DeferArgs>[];
  /** Statement names in the order they ran, across all transactions. */
  order: ("claim" | "defer")[];
  /** The same, with the zone read included — `order`'s three-statement form. */
  trace: ("read" | "claim" | "defer")[];
  transactions: () => number;
}

/**
 * A row-backed client double. `$transaction` is the house shape —
 * `(run) => run(tx)` — and builds a fresh transaction client per call whose two
 * statements record the client they ran on, which is what lets a test prove
 * both halves shared one transaction instead of one escaping to the outer
 * client. The claim writes through to the fake user row, so a second call in the
 * same test is answered the way Postgres would answer it: nothing left to
 * match.
 *
 * `timeZone` is the stored `User.timezone` the rollover reads first; it
 * defaults to UTC, which is also the column default.
 */
function harness(lastRolloverOn: Date | null, timeZone = "UTC"): Harness {
  const user: UserRow = { id: USER_ID, timezone: timeZone, lastRolloverOn };
  const tasks = taskTable();
  const reads: Recorded<ReadArgs>[] = [];
  const claims: Recorded<ClaimArgs>[] = [];
  const defers: Recorded<DeferArgs>[] = [];
  const order: ("claim" | "defer")[] = [];
  const trace: ("read" | "claim" | "defer")[] = [];
  let transactions = 0;

  const client: RolloverClient = {
    $transaction: (run) => {
      transactions += 1;

      const tx: RolloverTransactionClient = {
        user: {
          // The zone read the rollover opens with. Recorded in `reads` and in
          // `trace`, but deliberately absent from `order`, which stays the
          // claim-then-defer sequence most tests here assert on.
          findUnique: (args) => {
            reads.push({ args, tx });
            trace.push("read");

            return Promise.resolve({ timezone: user.timezone });
          },
          updateMany: (args) => {
            claims.push({ args, tx });
            order.push("claim");
            trace.push("claim");
            if (!claimMatches(args.where, user)) {
              return Promise.resolve({ count: 0 });
            }

            user.lastRolloverOn = args.data.lastRolloverOn;

            return Promise.resolve({ count: 1 });
          },
        },
        task: {
          updateMany: (args) => {
            defers.push({ args, tx });
            order.push("defer");
            trace.push("defer");

            return Promise.resolve({ count: applyDefer(args, tasks) });
          },
        },
      };

      return run(tx);
    },
  };

  return {
    client,
    user,
    tasks,
    reads,
    claims,
    defers,
    order,
    trace,
    transactions: () => transactions,
  };
}

/**
 * Re-imports the service. The zone now comes from the user's row rather than
 * the environment, so nothing has to be installed before the load — the fresh
 * import stays only so each test gets the module with its mocked `@mise/db`.
 */
async function loadRollover(): Promise<typeof import("./rollover.js")> {
  vi.resetModules();

  return await import("./rollover.js");
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("rolloverIfNeeded", () => {
  const NOW = new Date("2026-11-11T14:00:00.000Z");
  const TODAY = day("2026-11-11");

  /** The claim statement, spelled out rather than derived from the service. */
  const CLAIM = {
    where: {
      id: USER_ID,
      AND: [
        { OR: [{ lastRolloverOn: null }, { lastRolloverOn: { lt: TODAY } }] },
      ],
    },
    data: { lastRolloverOn: TODAY },
  };

  /** The defer statement, likewise. */
  const DEFER = {
    where: { userId: USER_ID, status: { in: ["TODO", "IN_PROGRESS"] } },
    data: { deferCount: { increment: 1 } },
  };

  describe("the first request of a new day", () => {
    it("claims the day with exactly the conditional statement", async () => {
      const { rolloverIfNeeded } = await loadRollover();
      const h = harness(day("2026-11-10"));

      await rolloverIfNeeded(USER_ID, NOW, h.client);

      expect(h.claims).toHaveLength(1);
      // Whole-statement equality: an extra condition, a missing one, or a
      // `lastRolloverOn` written as anything but today's UTC midnight fails
      // here. The `lt` bound is the whole concurrency story — `lte` would let
      // a second request re-claim the same day.
      expect(h.claims[0]?.args).toEqual(CLAIM);
      expect(h.user.lastRolloverOn).toEqual(TODAY);
    });

    it("increments deferCount by exactly one, scoped to this user", async () => {
      const { rolloverIfNeeded } = await loadRollover();
      const h = harness(day("2026-11-10"));

      await rolloverIfNeeded(USER_ID, NOW, h.client);

      expect(h.defers).toHaveLength(1);
      expect(h.defers[0]?.args).toEqual(DEFER);
      // And the rows the statement actually moved: the two unfinished ones by
      // one each.
      expect(taskById(h.tasks, "task-todo").deferCount).toBe(1);
      expect(taskById(h.tasks, "task-in-progress").deferCount).toBe(4);
      // The other user's task is untouched, even though it is also TODO.
      expect(taskById(h.tasks, "task-other").deferCount).toBe(0);
    });

    it("claims before it defers, and never touches the default client", async () => {
      const { rolloverIfNeeded } = await loadRollover();
      const h = harness(day("2026-11-10"));

      await rolloverIfNeeded(USER_ID, NOW, h.client);

      // Order is the safety property: deferring first would double-count under
      // a race, because the claim is what serializes the two requests.
      expect(h.order).toEqual(["claim", "defer"]);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("issues both statements on one transaction client", async () => {
      const { rolloverIfNeeded } = await loadRollover();
      const h = harness(day("2026-11-10"));

      await rolloverIfNeeded(USER_ID, NOW, h.client);

      expect(h.transactions()).toBe(1);
      // Same `tx` object for both: a defer on the outer client would commit
      // even when the claim rolled back.
      expect(h.defers[0]?.tx).toBe(h.claims[0]?.tx);
    });
  });

  it("rolls a fresh user whose lastRolloverOn is still null", async () => {
    const { rolloverIfNeeded } = await loadRollover();
    const h = harness(null);

    await rolloverIfNeeded(USER_ID, NOW, h.client);

    // The null branch of the `OR` is what makes this match — without it a user
    // who never rolled over would never roll over.
    expect(h.claims[0]?.args).toEqual(CLAIM);
    expect(h.defers).toHaveLength(1);
    expect(h.user.lastRolloverOn).toEqual(TODAY);
    expect(taskById(h.tasks, "task-todo").deferCount).toBe(1);
  });

  it("defers nothing on a second call the same day", async () => {
    const { rolloverIfNeeded } = await loadRollover();
    const h = harness(day("2026-11-10"));

    await rolloverIfNeeded(USER_ID, NOW, h.client);
    await rolloverIfNeeded(
      USER_ID,
      new Date("2026-11-11T19:45:00.000Z"),
      h.client,
    );

    // Two claims, one defer: the second claim matched nothing because the row
    // now reads today, so the second request leaves the counts alone.
    expect(h.claims).toHaveLength(2);
    expect(h.defers).toHaveLength(1);
    expect(h.order).toEqual(["claim", "defer", "claim"]);
    expect(taskById(h.tasks, "task-todo").deferCount).toBe(1);
    expect(taskById(h.tasks, "task-in-progress").deferCount).toBe(4);
  });

  it("does nothing at all when the claim loses the race", async () => {
    const { rolloverIfNeeded } = await loadRollover();
    // The state a concurrent loser re-reads: the winner already committed
    // today's date, so the loser's `where` matches no row.
    const h = harness(TODAY);

    await rolloverIfNeeded(USER_ID, NOW, h.client);

    expect(h.claims).toHaveLength(1);
    expect(h.defers).toHaveLength(0);
    // Still exactly one transaction — the claim is issued either way.
    expect(h.transactions()).toBe(1);
    expect(h.tasks.map((task) => task.deferCount)).toEqual([0, 3, 1, 2, 0]);
  });

  it("never targets a settled status", async () => {
    const { rolloverIfNeeded } = await loadRollover();
    const h = harness(day("2026-11-10"));

    await rolloverIfNeeded(USER_ID, NOW, h.client);

    const statuses = h.defers[0]?.args.where.status.in ?? [];
    expect(statuses).toEqual(["TODO", "IN_PROGRESS"]);
    expect(statuses).not.toContain("DONE");
    expect(statuses).not.toContain("DROPPED");
    // DONE and DROPPED keep the count they ended with.
    expect(taskById(h.tasks, "task-done").deferCount).toBe(1);
    expect(taskById(h.tasks, "task-dropped").deferCount).toBe(2);
  });

  it("charges a multi-day gap one increment, not one per day", async () => {
    const { rolloverIfNeeded } = await loadRollover();
    // Eight days away. A catch-up loop would show up as eight statements, or as
    // one statement with an increment of eight.
    const h = harness(day("2026-11-03"));

    await rolloverIfNeeded(USER_ID, NOW, h.client);

    expect(h.transactions()).toBe(1);
    expect(h.claims).toHaveLength(1);
    expect(h.defers).toHaveLength(1);
    expect(h.defers[0]?.args.data.deferCount.increment).toBe(1);
    expect(taskById(h.tasks, "task-todo").deferCount).toBe(1);
    expect(taskById(h.tasks, "task-in-progress").deferCount).toBe(4);
    // The date jumps straight to today rather than to the next missed day.
    expect(h.user.lastRolloverOn).toEqual(TODAY);
  });

  describe("the zone read", () => {
    /** The read statement, spelled out rather than derived from the service. */
    const READ = { where: { id: USER_ID }, select: { timezone: true } };

    it("reads only this user's timezone column", async () => {
      const { rolloverIfNeeded } = await loadRollover();
      const h = harness(day("2026-11-10"));

      await rolloverIfNeeded(USER_ID, NOW, h.client);

      expect(h.reads).toHaveLength(1);
      // Whole-statement equality: keyed by the id it was handed — on `User`
      // that *is* the user scope — and selecting nothing else. A column added
      // to the `select` would carry data this module has no use for.
      expect(h.reads[0]?.args).toEqual(READ);
    });

    it("reads the zone inside the claim's own transaction, before it", async () => {
      const { rolloverIfNeeded } = await loadRollover();
      const h = harness(day("2026-11-10"));

      await rolloverIfNeeded(USER_ID, NOW, h.client);

      // Read first, and on the same `tx`: a zone read outside the transaction
      // could be answered before another writer changed it, and the claim
      // would then write a day measured in a zone the row no longer holds.
      expect(h.trace).toEqual(["read", "claim", "defer"]);
      expect(h.transactions()).toBe(1);
      expect(h.reads[0]?.tx).toBe(h.claims[0]?.tx);
      expect(h.reads[0]?.tx).toBe(h.defers[0]?.tx);
    });

    it("claims nothing when the user row is gone", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { rolloverIfNeeded } = await loadRollover();
      const reads: ReadArgs[] = [];
      const claims: ClaimArgs[] = [];
      const defers: DeferArgs[] = [];
      let transactions = 0;
      // Its own double rather than `harness`, which is backed by a row that
      // exists: here `findUnique` answers `null`, the way Postgres answers a
      // session that outlived its user.
      const client: RolloverClient = {
        $transaction: (run) => {
          transactions += 1;

          return run({
            user: {
              findUnique: (args) => {
                reads.push(args);

                return Promise.resolve(null);
              },
              updateMany: (args) => {
                claims.push(args);

                return Promise.resolve({ count: 1 });
              },
            },
            task: {
              updateMany: (args) => {
                defers.push(args);

                return Promise.resolve({ count: 2 });
              },
            },
          });
        },
      };

      // Resolves rather than throwing: the caller is a middleware that must
      // not fail the request over bookkeeping, and the session is about to be
      // useless anyway.
      await expect(
        rolloverIfNeeded(USER_ID, NOW, client),
      ).resolves.toBeUndefined();

      expect(reads).toHaveLength(1);
      // No zone to measure a day in means no day to claim — and with no claim,
      // no defer. A claim here would advance `lastRolloverOn` on a row the
      // read just failed to find, or (worse) on the wrong row.
      expect(claims).toHaveLength(0);
      expect(defers).toHaveLength(0);
      // Still exactly one transaction, and no second attempt outside it.
      expect(transactions).toBe(1);
      expect(db.transaction).not.toHaveBeenCalled();
      // A missing row is not the unusable-zone fallback: nothing is logged.
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe("the day boundary", () => {
    // Each case is the same instant read in two zones, which is the whole
    // point: the date is the user's local one, not the server's.
    const CASES: {
      label: string;
      timeZone: string;
      now: string;
      expected: Date;
    }[] = [
      {
        label: "late evening in Chicago is still the local day",
        timeZone: "America/Chicago",
        now: "2026-11-12T03:30:00.000Z",
        expected: day("2026-11-11"),
      },
      {
        label: "the same instant has already turned over in UTC",
        timeZone: "UTC",
        now: "2026-11-12T03:30:00.000Z",
        expected: day("2026-11-12"),
      },
      {
        label: "a minute before local midnight in Chicago",
        timeZone: "America/Chicago",
        now: "2026-11-11T05:59:00.000Z",
        expected: day("2026-11-10"),
      },
      {
        label: "a minute after local midnight in Chicago",
        timeZone: "America/Chicago",
        now: "2026-11-11T06:01:00.000Z",
        expected: day("2026-11-11"),
      },
    ];

    for (const { label, timeZone, now, expected } of CASES) {
      it(label, async () => {
        const { rolloverIfNeeded } = await loadRollover();
        const h = harness(null, timeZone);

        await rolloverIfNeeded(USER_ID, new Date(now), h.client);

        const args = h.claims[0]?.args;
        // Both places the date appears: the bound the claim compares against
        // and the value it writes. A midnight built in local time rather than
        // UTC would be off by the offset and fail here.
        expect(args?.data.lastRolloverOn).toEqual(expected);
        expect(args?.where.AND[0]?.OR[1]?.lastRolloverOn.lt).toEqual(expected);
        expect(args?.data.lastRolloverOn.toISOString()).toBe(
          expected.toISOString(),
        );
      });
    }
  });

  describe("two users at the same instant", () => {
    /** The stored zones, one per row, looked up by the id the service sends. */
    const ZONES: Record<string, string> = {
      [USER_ID]: "America/Chicago",
      [OTHER_USER_ID]: "Asia/Tokyo",
    };

    /**
     * A two-row client double. `findUnique` answers from the id in the `where`
     * rather than from a fixed value, which is the point: a service that read
     * the zone of anything but the user it was handed shows up here as the
     * wrong day.
     */
    function twoUserClient(
      claims: ClaimArgs[],
      defers: DeferArgs[],
    ): RolloverClient {
      return {
        $transaction: (run) =>
          run({
            user: {
              findUnique: ({ where }) => {
                const timezone = ZONES[where.id];

                return Promise.resolve(
                  timezone === undefined ? null : { timezone },
                );
              },
              updateMany: (args) => {
                claims.push(args);

                return Promise.resolve({ count: 1 });
              },
            },
            task: {
              updateMany: (args) => {
                defers.push(args);

                return Promise.resolve({ count: 1 });
              },
            },
          }),
      };
    }

    it("claims a different calendar day per stored zone", async () => {
      const { rolloverIfNeeded } = await loadRollover();
      const claims: ClaimArgs[] = [];
      const defers: DeferArgs[] = [];
      const client = twoUserClient(claims, defers);
      // 14:00 on the 11th in Chicago, 05:00 on the *12th* in Tokyo.
      const now = new Date("2026-11-11T20:00:00.000Z");

      await rolloverIfNeeded(USER_ID, now, client);
      await rolloverIfNeeded(OTHER_USER_ID, now, client);

      expect(claims).toHaveLength(2);
      // One instant, two local days: the zone is per user, so a process-wide
      // one (an env var, the server's own) would make these two equal.
      expect(claims[0]?.where.id).toBe(USER_ID);
      expect(claims[0]?.data.lastRolloverOn).toEqual(day("2026-11-11"));
      expect(claims[1]?.where.id).toBe(OTHER_USER_ID);
      expect(claims[1]?.data.lastRolloverOn).toEqual(day("2026-11-12"));
      expect(claims[0]?.data.lastRolloverOn).not.toEqual(
        claims[1]?.data.lastRolloverOn,
      );
      // And each defer stayed with its own user.
      expect(defers.map((defer) => defer.where.userId)).toEqual([
        USER_ID,
        OTHER_USER_ID,
      ]);
    });

    it("measures the same day when both zones agree on it", async () => {
      const { rolloverIfNeeded } = await loadRollover();
      const claims: ClaimArgs[] = [];
      const defers: DeferArgs[] = [];
      const client = twoUserClient(claims, defers);
      // Mid-morning UTC: 04:00 in Chicago, 19:00 in Tokyo, the 11th in both.
      const now = new Date("2026-11-11T10:00:00.000Z");

      await rolloverIfNeeded(USER_ID, now, client);
      await rolloverIfNeeded(OTHER_USER_ID, now, client);

      // The counterpart to the test above: different zones are not *always* a
      // different day, so the one above is about the boundary, not the zones.
      expect(claims[0]?.data.lastRolloverOn).toEqual(day("2026-11-11"));
      expect(claims[1]?.data.lastRolloverOn).toEqual(day("2026-11-11"));
    });
  });

  // Was "an unusable USER_TZ" before the zone moved into the user's row: a
  // typo can no longer reach the column (`routes/settings.schema.ts` validates
  // it), so the bad value is a stored one and must cost a day measured in UTC
  // rather than every request of it.
  describe("an unusable stored zone", () => {
    const BAD_ZONE = "Mars/Olympus_Mons";

    it("falls back to UTC instead of failing the rollover", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { rolloverIfNeeded } = await loadRollover();
      const h = harness(null, BAD_ZONE);

      await rolloverIfNeeded(
        USER_ID,
        new Date("2026-11-12T03:30:00.000Z"),
        h.client,
      );

      // The UTC day of that instant — the Chicago one would be the 11th.
      expect(h.claims[0]?.args.data.lastRolloverOn).toEqual(day("2026-11-12"));
      expect(h.defers).toHaveLength(1);
    });

    // Replaces the deleted `USER_TZ: "   "` case: a blank value can no longer
    // come from the environment, but the column can still hold one after an
    // out-of-band write, and it must behave like any other unusable zone
    // rather than throw out of the `Intl` constructor.
    it.each(["", "   ", "Etc/Nowhere", "America/Chicago "])(
      "measures the day in UTC for the stored zone %j",
      async (zone) => {
        const errorSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});
        const { rolloverIfNeeded } = await loadRollover();
        const h = harness(null, zone);

        await rolloverIfNeeded(
          USER_ID,
          new Date("2026-11-12T03:30:00.000Z"),
          h.client,
        );

        expect(h.claims[0]?.args.data.lastRolloverOn).toEqual(
          day("2026-11-12"),
        );
        expect(h.defers).toHaveLength(1);
        // One line per rollover, not one per statement.
        expect(errorSpy).toHaveBeenCalledTimes(1);
      },
    );

    it("logs the fallback once per process, not once per request", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { rolloverIfNeeded } = await loadRollover();
      const first = harness(null, BAD_ZONE);
      const second = harness(day("2026-11-12"), BAD_ZONE);

      await rolloverIfNeeded(
        USER_ID,
        new Date("2026-11-12T03:30:00.000Z"),
        first.client,
      );
      await rolloverIfNeeded(
        USER_ID,
        new Date("2026-11-12T05:30:00.000Z"),
        second.client,
      );

      // The second request still measures its day in UTC but adds no line —
      // the condition persists until the column is rewritten, so repeating
      // the message would only drown the log.
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it("names the column without quoting its value", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { rolloverIfNeeded } = await loadRollover();
      const h = harness(null, BAD_ZONE);

      await rolloverIfNeeded(USER_ID, NOW, h.client);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.join(" ")).toContain("User.timezone");
      expect(errorSpy.mock.calls[0]?.join(" ")).not.toContain(BAD_ZONE);
    });
  });
});
