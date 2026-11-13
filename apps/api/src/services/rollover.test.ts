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
    user: { updateMany: db.transaction },
    task: { updateMany: db.transaction },
    $transaction: db.transaction,
  },
}));

import type { TaskStatus } from "@mise/shared";

import type { RolloverClient, RolloverTransactionClient } from "./rollover.js";

const USER_ID = "user-cuid-m3t3";
/** A second user, present in the fake task table and never to be touched. */
const OTHER_USER_ID = "user-cuid-m3t3-other";

/** The two statement shapes, read off the service's own narrowed interface. */
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
  claims: Recorded<ClaimArgs>[];
  defers: Recorded<DeferArgs>[];
  /** Statement names in the order they ran, across all transactions. */
  order: ("claim" | "defer")[];
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
 */
function harness(lastRolloverOn: Date | null): Harness {
  const user: UserRow = { id: USER_ID, lastRolloverOn };
  const tasks = taskTable();
  const claims: Recorded<ClaimArgs>[] = [];
  const defers: Recorded<DeferArgs>[] = [];
  const order: ("claim" | "defer")[] = [];
  let transactions = 0;

  const client: RolloverClient = {
    $transaction: (run) => {
      transactions += 1;

      const tx: RolloverTransactionClient = {
        user: {
          updateMany: (args) => {
            claims.push({ args, tx });
            order.push("claim");
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
    claims,
    defers,
    order,
    transactions: () => transactions,
  };
}

/**
 * Re-imports the service with `USER_TZ` installed (or removed when undefined).
 * The zone is read once at module load, so a test that cares about it has to
 * reload — same approach as `crypto/tokenCrypto.test.ts`.
 */
async function loadRollover(
  timeZone?: string,
): Promise<typeof import("./rollover.js")> {
  vi.resetModules();
  vi.stubEnv("USER_TZ", timeZone);

  return await import("./rollover.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
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

  describe("the day boundary", () => {
    // Each case is the same instant read in two zones, which is the whole
    // point: the date is the user's local one, not the server's.
    const CASES: {
      label: string;
      timeZone: string | undefined;
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
        timeZone: undefined,
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
      {
        label: "an empty USER_TZ falls back to UTC",
        timeZone: "   ",
        now: "2026-11-12T03:30:00.000Z",
        expected: day("2026-11-12"),
      },
    ];

    for (const { label, timeZone, now, expected } of CASES) {
      it(label, async () => {
        const { rolloverIfNeeded } = await loadRollover(timeZone);
        const h = harness(null);

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

    it("reads the zone once, at module load", async () => {
      const { rolloverIfNeeded } = await loadRollover("America/Chicago");
      // Changing the variable after the fact must not change the day — the
      // module captured its formatter at load.
      vi.stubEnv("USER_TZ", "Asia/Tokyo");
      const h = harness(null);

      await rolloverIfNeeded(
        USER_ID,
        new Date("2026-11-12T03:30:00.000Z"),
        h.client,
      );

      expect(h.claims[0]?.args.data.lastRolloverOn).toEqual(day("2026-11-11"));
    });
  });

  describe("an unusable USER_TZ", () => {
    const BAD_ZONE = "Mars/Olympus_Mons";

    it("fails at module load rather than on a request", async () => {
      await expect(loadRollover(BAD_ZONE)).rejects.toThrow(
        "Invalid IANA time zone in env var: USER_TZ",
      );
    });

    it("names the variable without quoting its value", async () => {
      const error = await loadRollover(BAD_ZONE).catch(
        (cause: unknown) => cause,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(BAD_ZONE);
    });
  });
});
