import session from "express-session";
import passport from "passport";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

// Prisma is mocked at the module boundary: these tests drive the real app —
// every middleware, the real gate, the real validators — so the only thing
// standing in for a database is the client the task service defaults to. The
// spies live outside the factory (`vi.hoisted`) so the suite can re-arm them
// per test. The two `user` statements are the ones an authenticated request
// makes before reaching a route: `findUnique` for `deserializeUser`, and
// `updateMany` for the day rollover.
const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  // The day rollover's claim on the user row, which every authenticated request
  // now carries (`middleware/rollover.ts`). Armed below to "already rolled over
  // today", so the rollover opens its transaction and touches no task — the
  // steady state these tests are about.
  userUpdateMany: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  // The outer client's two transactional statements: never expected to run,
  // since `updateTask` must issue both through the transaction client. Kept
  // distinct from the `tx*` spies below precisely so that can be asserted, and
  // deliberately left unarmed — one escaping the transaction then rejects on an
  // undefined result instead of quietly answering like the `tx*` double would.
  updateMany: vi.fn(),
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
  transaction: vi.fn(),
  txUpdateMany: vi.fn(),
  txFindFirst: vi.fn(),
}));

vi.mock("@mise/db", () => ({
  prisma: {
    user: { findUnique: db.findUnique, updateMany: db.userUpdateMany },
    task: {
      findMany: db.findMany,
      create: db.create,
      updateMany: db.updateMany,
      findFirst: db.findFirst,
      deleteMany: db.deleteMany,
    },
    $transaction: db.transaction,
  },
}));

import type { Task, TaskSource, TaskStatus } from "@mise/shared";

import { createApp } from "../app.js";
import { configurePassport } from "../auth/passport.js";
import { SESSION_COOKIE_NAME } from "../auth/session.js";
import type { TaskTransactionClient } from "../services/tasks.js";

const USER_ID = "user-cuid-m3t2";
const OTHER_USER_ID = "user-cuid-m3t2-other";
const SESSION_USER = {
  id: USER_ID,
  email: "chef@example.com",
  name: "Mise Chef",
};

const TASK_ID = "task-cuid-m3t2";
/** A real id, but one that belongs to `OTHER_USER_ID`. */
const OTHER_TASK_ID = "task-cuid-m3t2-other";

// Timestamps are written as the ISO strings the wire must carry and the `Date`
// built from each, so the DTO expectations below are literals rather than a
// second copy of the service's own conversion.
const CREATED_ISO = "2026-11-10T08:00:00.000Z";
const UPDATED_ISO = "2026-11-10T09:30:00.000Z";
const DUE_ISO = "2026-11-11T17:00:00.000Z";
const CREATED_AT = new Date(CREATED_ISO);
const UPDATED_AT = new Date(UPDATED_ISO);
const DUE_AT = new Date(DUE_ISO);

/** A row as the service's `select` returns it: the DTO with `Date` timestamps. */
interface TaskRow {
  id: string;
  title: string;
  project: string | null;
  estimateMin: number | null;
  priority: number;
  dueAt: Date | null;
  status: TaskStatus;
  source: TaskSource;
  deferCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK_ID,
    title: "Prep the mise en place",
    project: "mise",
    estimateMin: 30,
    priority: 2,
    dueAt: DUE_AT,
    status: "TODO",
    source: "MANUAL",
    deferCount: 0,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

/** The wire shape of `taskRow()` — spelled out, not derived from the row. */
function taskDto(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "Prep the mise en place",
    project: "mise",
    estimateMin: 30,
    priority: 2,
    dueAt: DUE_ISO,
    status: "TODO",
    source: "MANUAL",
    deferCount: 0,
    createdAt: CREATED_ISO,
    updatedAt: UPDATED_ISO,
    ...overrides,
  };
}

/**
 * What an `updateMany` double answers: 1 when `data` names at least one field,
 * 0 when it names none. Derived rather than hard-coded, because Postgres
 * matches *zero* rows for an `updateMany` with an empty `data` — a fixed
 * `{ count: 1 }` would let a patch that names nothing pass here as a 200 while
 * 404-ing in production. A test that wants a particular count still overrides
 * this with its own `mockResolvedValue`/`mockImplementation`.
 */
function updateManyCount({
  data,
}: {
  data: Record<string, unknown>;
}): Promise<{ count: number }> {
  const names = Object.values(data).some((value) => value !== undefined);

  return Promise.resolve({ count: names ? 1 : 0 });
}

/** Which statement ran on which transaction client, in order. */
interface TxCall {
  method: "updateMany" | "findFirst";
  tx: TaskTransactionClient;
}

const txCalls: TxCall[] = [];

/**
 * The transaction client both callers see: the task service's two statements
 * plus the rollover's claim on the user row.
 */
type TxDouble = TaskTransactionClient & {
  user: {
    findUnique: (args: unknown) => Promise<{ timezone: string } | null>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
};

/**
 * The `$transaction` double: builds a fresh transaction client per call whose
 * two statements delegate to the `tx*` spies while recording the client they
 * ran on. That record is what lets a test prove both halves of an update
 * shared one transaction instead of one of them escaping to the outer client.
 */
function runInTransaction<T>(run: (tx: TxDouble) => Promise<T>): Promise<T> {
  const tx: TxDouble = {
    user: {
      // The zone the rollover reads before its claim (`services/rollover.ts`).
      // Armed to the column default, so the day it measures is the UTC one and
      // these tests stay indifferent to the machine's zone.
      findUnique: () => Promise.resolve({ timezone: "UTC" }),
      updateMany: (args) =>
        db.userUpdateMany(args) as Promise<{ count: number }>,
    },
    task: {
      updateMany: (args) => {
        txCalls.push({ method: "updateMany", tx });
        return db.txUpdateMany(args) as Promise<{ count: number }>;
      },
      findFirst: (args) => {
        txCalls.push({ method: "findFirst", tx });
        return db.txFindFirst(args) as Promise<TaskRow | null>;
      },
    },
  };

  return run(tx);
}

/**
 * Every task-table spy, for the "no task statement ran" assertions. `db
 * .transaction` is deliberately not one of them: the rollover above the router
 * opens a transaction on every authenticated request, so an open transaction no
 * longer says anything about the task table.
 */
function taskSpies(): Mock[] {
  return [
    db.findMany,
    db.create,
    db.updateMany,
    db.findFirst,
    db.deleteMany,
    db.txUpdateMany,
    db.txFindFirst,
  ];
}

function expectNoTaskQuery(): void {
  for (const spy of taskSpies()) {
    expect(spy).not.toHaveBeenCalled();
  }
}

/** The first argument of a spy's most recent call, read back for assertions. */
function lastArg<T>(spy: Mock): T {
  expect(spy).toHaveBeenCalled();

  return spy.mock.calls.at(-1)?.[0] as T;
}

/** Set while the Google strategy double is installed; see `afterEach`. */
let stubInstalled = false;

/**
 * Replaces the Google strategy with a double that succeeds immediately, so a
 * test can get a signed-in cookie without talking to Google. Must be called
 * *after* `createApp`, which re-registers the real strategy by the same name.
 */
function useSuccessStrategy(): void {
  const strategy = {
    name: "google",
    authenticate(this: { success(user: Express.User): void }) {
      this.success(SESSION_USER);
    },
  };

  passport.use(strategy as unknown as passport.Strategy);
  stubInstalled = true;
}

function buildApp() {
  return createApp({ sessionStore: new session.MemoryStore() });
}

function setCookieHeaders(response: {
  headers: Record<string, unknown>;
}): string[] {
  const raw = response.headers["set-cookie"];
  if (Array.isArray(raw)) {
    return raw as string[];
  }

  return typeof raw === "string" ? [raw] : [];
}

/** The `name=value` pair of the session cookie, ready to be sent back. */
function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const cookie = setCookieHeaders(response).find((value) =>
    value.startsWith(`${SESSION_COOKIE_NAME}=`),
  );
  expect(
    cookie,
    `expected a ${SESSION_COOKIE_NAME} Set-Cookie header`,
  ).toBeDefined();

  return (cookie as string).split(";")[0] ?? "";
}

/**
 * Runs both sign-in legs with the success double and returns the cookie a
 * signed-in client is left holding. Costs two requests against the auth rate
 * limit, which is why every test builds its own app.
 */
async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const start = await request(app).get("/api/auth/google");
  expect(start.status).toBe(302);

  useSuccessStrategy();
  const callback = await request(app)
    .get("/api/auth/google/callback?code=fake-auth-code")
    .set("Cookie", sessionCookie(start));
  expect(callback.status).toBe(302);

  return sessionCookie(callback);
}

/** An app plus the cookie of a signed-in client, which is most tests' setup. */
async function signedInApp(): Promise<{
  app: ReturnType<typeof createApp>;
  cookie: string;
}> {
  const app = buildApp();

  return { app, cookie: await signIn(app) };
}

describe("the tasks router", () => {
  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    // `createApp` configures Passport, which requires the Google credentials
    // up front. Values are placeholders; nothing here calls Google.
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv(
      "GOOGLE_CALLBACK_URL",
      "http://localhost:3000/api/auth/google/callback",
    );
    vi.stubEnv("WEB_ORIGIN", "http://localhost:5173");

    txCalls.length = 0;
    for (const spy of [
      db.findUnique,
      db.userUpdateMany,
      db.transaction,
      ...taskSpies(),
    ]) {
      spy.mockReset();
    }

    db.findUnique.mockResolvedValue(SESSION_USER);
    // Today's rollover is already done, so it claims nothing and defers
    // nothing. `services/rollover.test.ts` owns the other branch.
    db.userUpdateMany.mockResolvedValue({ count: 0 });
    // Defaults every test can rely on: an empty list, a successful write.
    // A test that cares re-arms the one spy it is about.
    db.findMany.mockResolvedValue([]);
    db.create.mockResolvedValue(taskRow());
    db.deleteMany.mockResolvedValue({ count: 1 });
    db.transaction.mockImplementation(runInTransaction);
    db.txUpdateMany.mockImplementation(updateManyCount);
    db.txFindFirst.mockResolvedValue(taskRow());
  });

  afterEach(() => {
    // The Passport singleton is shared, so the real strategy goes back before
    // the env stubs come off — a leaked double would silently authenticate
    // another suite's requests.
    if (stubInstalled) {
      passport.unuse("google");
      configurePassport();
      stubInstalled = false;
    }

    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("round-trips a created task into the list", async () => {
    const { app, cookie } = await signedInApp();

    const created = await request(app)
      .post("/api/tasks")
      .set("Cookie", cookie)
      .send({
        title: "Prep the mise en place",
        project: "mise",
        estimateMin: 30,
        priority: 2,
        dueAt: DUE_ISO,
      });

    expect(created.status).toBe(201);
    expect(created.headers["content-type"]).toMatch(/application\/json/);
    // Timestamps cross the wire as ISO strings; `dueAt` goes to Prisma as a
    // `Date` and comes back as a string.
    expect(created.body).toEqual(taskDto());
    expect(db.create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        title: "Prep the mise en place",
        project: "mise",
        estimateMin: 30,
        priority: 2,
        dueAt: DUE_AT,
        // Explicit, because the column defaults to `DUMP`.
        source: "MANUAL",
      },
      select: expect.anything(),
    });

    // The stored row is now what the table holds, so the list must show it.
    db.findMany.mockResolvedValue([taskRow()]);
    const listed = await request(app).get("/api/tasks").set("Cookie", cookie);

    expect(listed.status).toBe(200);
    // A bare array, not an envelope.
    expect(listed.body).toEqual([taskDto()]);
  });

  describe("listing", () => {
    it("narrows the query to the status the client asked for", async () => {
      const { app, cookie } = await signedInApp();
      db.findMany.mockResolvedValue([taskRow({ status: "IN_PROGRESS" })]);

      const response = await request(app)
        .get("/api/tasks?status=IN_PROGRESS")
        .set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.body).toEqual([taskDto({ status: "IN_PROGRESS" })]);
      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER_ID, status: "IN_PROGRESS" },
        }),
      );
    });

    it("sends no status condition at all when the filter is absent", async () => {
      const { app, cookie } = await signedInApp();

      await request(app).get("/api/tasks").set("Cookie", cookie).expect(200);

      // `toEqual` would accept `status: undefined`, which Prisma reads as
      // "no filter" today but is a different statement on paper — so the keys
      // are checked, not just the values.
      const { where } = lastArg<{ where: Record<string, unknown> }>(
        db.findMany,
      );
      expect(Object.keys(where)).toEqual(["userId"]);
      expect(where.userId).toBe(USER_ID);
    });

    it("orders by priority, then due date with undated last, then creation", async () => {
      const { app, cookie } = await signedInApp();

      await request(app).get("/api/tasks").set("Cookie", cookie).expect(200);

      // The client is a double, so what is asserted is the statement the
      // service issues — the ordering Postgres then performs is out of scope.
      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { priority: "asc" },
            { dueAt: { sort: "asc", nulls: "last" } },
            { createdAt: "asc" },
          ],
        }),
      );
    });

    it("answers an empty list with an empty array", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .get("/api/tasks")
        .set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(response.body).toEqual([]);
    });

    it("refuses an unknown status value without querying", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .get("/api/tasks?status=ALMOST_DONE")
        .set("Cookie", cookie);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(response.body.fields).toHaveProperty("status");
      expect(db.findMany).not.toHaveBeenCalled();
    });
  });

  describe("creating", () => {
    it("leaves an omitted field to Prisma and still names the source", async () => {
      const { app, cookie } = await signedInApp();
      db.create.mockResolvedValue(
        taskRow({ project: null, estimateMin: null, dueAt: null }),
      );

      const response = await request(app)
        .post("/api/tasks")
        .set("Cookie", cookie)
        .send({ title: "Buy shallots" });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(
        taskDto({ project: null, estimateMin: null, dueAt: null }),
      );
      // No `project`/`estimateMin`/`priority`/`dueAt` value: each must reach
      // Prisma as `undefined` so the column default applies, rather than as a
      // `null` that would overwrite it.
      expect(db.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            userId: USER_ID,
            title: "Buy shallots",
            project: undefined,
            estimateMin: undefined,
            priority: undefined,
            dueAt: undefined,
            source: "MANUAL",
          },
        }),
      );
    });

    it("refuses a bad payload with per-field messages and no write", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .post("/api/tasks")
        .set("Cookie", cookie)
        .send({ title: "   ", priority: 9, nope: true });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(Object.keys(response.body.fields).sort()).toEqual([
        "nope",
        "priority",
        "title",
      ]);
      expect(db.create).not.toHaveBeenCalled();
    });
  });

  describe("updating", () => {
    it("applies a status transition inside one transaction", async () => {
      const { app, cookie } = await signedInApp();
      db.txFindFirst.mockResolvedValue(taskRow({ status: "DONE" }));

      const response = await request(app)
        .patch(`/api/tasks/${TASK_ID}`)
        .set("Cookie", cookie)
        .send({ status: "DONE" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(taskDto({ status: "DONE" }));
      // Addressed by the `[id, userId]` pair, never by the id alone.
      expect(db.txUpdateMany).toHaveBeenCalledWith({
        where: { id: TASK_ID, userId: USER_ID },
        data: { status: "DONE" },
      });

      // Write then read-back, both on the same transaction client: a read on
      // the outer client could report another writer's value. Two
      // transactions in all — the day rollover opens its own above the router.
      expect(db.transaction).toHaveBeenCalledTimes(2);
      expect(txCalls.map((call) => call.method)).toEqual([
        "updateMany",
        "findFirst",
      ]);
      expect(txCalls[0]?.tx).toBe(txCalls[1]?.tx);
      expect(db.updateMany).not.toHaveBeenCalled();
      expect(db.findFirst).not.toHaveBeenCalled();
    });

    it("clears a nullable field when the patch sends null", async () => {
      const { app, cookie } = await signedInApp();
      db.txFindFirst.mockResolvedValue(taskRow({ project: null }));

      const response = await request(app)
        .patch(`/api/tasks/${TASK_ID}`)
        .set("Cookie", cookie)
        .send({ project: null });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(taskDto({ project: null }));
      // `null` must survive as `null` — dropped, the column would keep its
      // old value and the response would contradict the request.
      expect(db.txUpdateMany).toHaveBeenCalledWith({
        where: { id: TASK_ID, userId: USER_ID },
        data: { project: null },
      });
    });

    it("refuses a patch that names no field, before any statement", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch(`/api/tasks/${TASK_ID}`)
        .set("Cookie", cookie)
        .send({});

      // Not servable as a no-op: Postgres matches zero rows for an
      // `updateMany` with an empty `data`, which the service reads as "not
      // yours" — so an existing task would 404. The 400 happens at the
      // boundary instead, with the issue filed under the root key because it
      // belongs to the whole object rather than to any one field.
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: "Validation failed",
        fields: { _root: "Provide at least one field to update" },
      });
      // And no statement reached the task table — the refusal costs no query.
      expectNoTaskQuery();
    });

    it("answers 404 when the pair matches no row, and reads nothing back", async () => {
      const { app, cookie } = await signedInApp();
      db.txUpdateMany.mockResolvedValue({ count: 0 });

      const response = await request(app)
        .patch(`/api/tasks/${TASK_ID}`)
        .set("Cookie", cookie)
        .send({ title: "Renamed" });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Not Found" });
      expect(db.txFindFirst).not.toHaveBeenCalled();
    });
  });

  describe("deleting", () => {
    it("answers 204 with an empty body", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .delete(`/api/tasks/${TASK_ID}`)
        .set("Cookie", cookie);

      expect(response.status).toBe(204);
      expect(response.text).toBe("");
      expect(db.deleteMany).toHaveBeenCalledWith({
        where: { id: TASK_ID, userId: USER_ID },
      });
    });

    it("answers 404 when the pair matches no row", async () => {
      const { app, cookie } = await signedInApp();
      db.deleteMany.mockResolvedValue({ count: 0 });

      const response = await request(app)
        .delete(`/api/tasks/${TASK_ID}`)
        .set("Cookie", cookie);

      // Worded exactly like the path-less 404: a count of 0 is no oracle for
      // whether the row exists under another user.
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Not Found" });
    });
  });

  describe("cross-user isolation", () => {
    /** Two users' rows; the double answers only what a `where` actually matches. */
    const TABLE: { row: TaskRow; userId: string }[] = [
      { row: taskRow(), userId: USER_ID },
      {
        row: taskRow({ id: OTHER_TASK_ID, title: "Someone else's task" }),
        userId: OTHER_USER_ID,
      },
    ];

    interface ScopedWhere {
      where: { id?: string; userId: string };
    }

    function matches({ where }: ScopedWhere): typeof TABLE {
      return TABLE.filter(
        (entry) =>
          entry.userId === where.userId &&
          (where.id === undefined || entry.row.id === where.id),
      );
    }

    beforeEach(() => {
      db.findMany.mockImplementation((args: ScopedWhere) =>
        Promise.resolve(matches(args).map((entry) => entry.row)),
      );
      db.txUpdateMany.mockImplementation((args: ScopedWhere) =>
        Promise.resolve({ count: matches(args).length }),
      );
      db.deleteMany.mockImplementation((args: ScopedWhere) =>
        Promise.resolve({ count: matches(args).length }),
      );
    });

    it("never lists another user's rows", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .get("/api/tasks")
        .set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.body).toEqual([taskDto()]);
      expect(
        lastArg<{ where: { userId: string } }>(db.findMany).where.userId,
      ).toBe(USER_ID);
    });

    it("refuses a PATCH of another user's task id as a 404", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch(`/api/tasks/${OTHER_TASK_ID}`)
        .set("Cookie", cookie)
        .send({ title: "Mine now" });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Not Found" });
      // The session's user id is the one in the `where` — the id in the path
      // cannot widen the scope, and no row was read back.
      expect(db.txUpdateMany).toHaveBeenCalledWith({
        where: { id: OTHER_TASK_ID, userId: USER_ID },
        data: { title: "Mine now" },
      });
      expect(db.txFindFirst).not.toHaveBeenCalled();
    });

    it("refuses a DELETE of another user's task id as a 404", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .delete(`/api/tasks/${OTHER_TASK_ID}`)
        .set("Cookie", cookie);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Not Found" });
      expect(db.deleteMany).toHaveBeenCalledWith({
        where: { id: OTHER_TASK_ID, userId: USER_ID },
      });
    });
  });

  describe("the :id parameter", () => {
    // Charset and length only — enough that a traversal- or injection-shaped
    // id never reaches the database.
    const GARBAGE_IDS: { label: string; id: string }[] = [
      { label: "a path traversal", id: "..%2F..%2Fetc%2Fpasswd" },
      { label: "a quoted fragment", id: "x'%20OR%20'1'%3D'1" },
      { label: "an over-long value", id: "a".repeat(65) },
    ];

    for (const { label, id } of GARBAGE_IDS) {
      it(`refuses a PATCH with ${label} before any query`, async () => {
        const { app, cookie } = await signedInApp();

        const response = await request(app)
          .patch(`/api/tasks/${id}`)
          .set("Cookie", cookie)
          .send({ title: "Renamed" });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("Validation failed");
        expect(response.body.fields).toHaveProperty("id");
        expectNoTaskQuery();
      });

      it(`refuses a DELETE with ${label} before any query`, async () => {
        const { app, cookie } = await signedInApp();

        const response = await request(app)
          .delete(`/api/tasks/${id}`)
          .set("Cookie", cookie);

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("Validation failed");
        expect(response.body.fields).toHaveProperty("id");
        expectNoTaskQuery();
      });
    }

    it("validates the id ahead of the body", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/tasks/not a cuid")
        .set("Cookie", cookie)
        .send({ status: "NONSENSE" });

      // Both are invalid; only the id is reported, which is what proves the
      // param validator ran first and short-circuited.
      expect(response.status).toBe(400);
      expect(Object.keys(response.body.fields)).toEqual(["id"]);
      expectNoTaskQuery();
    });
  });

  describe("the day rollover above the router", () => {
    it("claims the day for the session's user before the list query", async () => {
      const { app, cookie } = await signedInApp();

      await request(app).get("/api/tasks").expect(401);
      // Unauthenticated: the rollover sits below the gate, so a refused
      // request costs no claim.
      expect(db.userUpdateMany).not.toHaveBeenCalled();

      await request(app).get("/api/tasks").set("Cookie", cookie).expect(200);

      expect(db.userUpdateMany).toHaveBeenCalledTimes(1);
      const claim = lastArg<{
        where: { id: string };
        data: { lastRolloverOn: Date };
      }>(db.userUpdateMany);
      // Keyed by the session's user, and advancing the date to a real day —
      // `services/rollover.test.ts` pins the statement down in full.
      expect(claim.where.id).toBe(USER_ID);
      expect(claim.data.lastRolloverOn).toBeInstanceOf(Date);

      // Ordering is what the mount position buys: a handler that reads
      // `deferCount` must see the post-rollover value, not yesterday's.
      const claimedAt = db.userUpdateMany.mock.invocationCallOrder[0] ?? 0;
      const listedAt = db.findMany.mock.invocationCallOrder[0] ?? 0;
      expect(claimedAt).toBeLessThan(listedAt);
    });

    it("still serves the list when the rollover fails", async () => {
      const { app, cookie } = await signedInApp();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      // The rollover transaction is the only one a GET opens, so failing it
      // fails exactly the rollover.
      db.transaction.mockRejectedValueOnce(new Error("rollover tx failed"));
      db.findMany.mockResolvedValue([taskRow()]);

      const response = await request(app)
        .get("/api/tasks")
        .set("Cookie", cookie);

      // Bookkeeping never costs the caller their response: the list is served
      // with whatever `deferCount`s the table still holds.
      expect(response.status).toBe(200);
      expect(response.body).toEqual([taskDto()]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("the auth gate", () => {
    it("scopes the query to the signed-in session's user", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .get("/api/tasks")
        .set("Cookie", cookie);

      expect(response.status).toBe(200);
      // End to end through the real stack: the session was deserialized, the
      // gate attached its user id, and that id is the one in the statement.
      expect(db.findUnique).toHaveBeenCalled();
      expect(db.findMany).toHaveBeenCalledTimes(1);
      expect(
        lastArg<{ where: { userId: string } }>(db.findMany).where.userId,
      ).toBe(USER_ID);
    });

    it("refuses an unauthenticated list before any service code runs", async () => {
      const response = await request(buildApp()).get("/api/tasks");

      expect(response.status).toBe(401);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(response.body).toEqual({ error: "Unauthorized" });
      // The gate is above the router, so a refusal costs no query at all.
      expect(db.findUnique).not.toHaveBeenCalled();
      expectNoTaskQuery();
    });

    it("refuses an unauthenticated write before any service code runs", async () => {
      const app = buildApp();

      const created = await request(app)
        .post("/api/tasks")
        .send({ title: "Prep the mise en place" });
      expect(created.status).toBe(401);
      expect(created.body).toEqual({ error: "Unauthorized" });

      const patched = await request(app)
        .patch(`/api/tasks/${TASK_ID}`)
        .send({ status: "DONE" });
      expect(patched.status).toBe(401);

      const deleted = await request(app).delete(`/api/tasks/${TASK_ID}`);
      expect(deleted.status).toBe(401);

      expectNoTaskQuery();
    });
  });
});
