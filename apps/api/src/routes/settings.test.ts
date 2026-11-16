import session from "express-session";
import passport from "passport";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prisma is mocked at the module boundary, as in `routes/tasks.test.ts`: these
// tests drive the real app — session, Passport, the gate, the rollover, the
// real validator — so the only stand-in is the client the settings service
// defaults to. `user.findUnique` is shared by two callers and is dispatched on
// its `select` below: `deserializeUser` asks for the identity columns,
// `getSettings` for the two DTO ones.
const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  // The detection write: `user.updateMany` outside any transaction.
  updateMany: vi.fn(),
  // The day rollover's claim on the user row, which every authenticated
  // request carries (`middleware/rollover.ts`). Reached only through the
  // transaction double below, so it never aliases the detection write. Armed
  // to "already rolled over today", so it touches nothing.
  claimDay: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@mise/db", () => ({
  prisma: {
    user: {
      findUnique: db.findUnique,
      update: db.update,
      updateMany: db.updateMany,
    },
    $transaction: db.transaction,
  },
}));

import type { Settings, TimezoneSource } from "@mise/shared";

import { createApp } from "../app.js";
import { configurePassport } from "../auth/passport.js";
import { SESSION_COOKIE_NAME } from "../auth/session.js";

const USER_ID = "user-cuid-m3t5";
/** A second row in the fake user table, never to be read or written. */
const OTHER_USER_ID = "user-cuid-m3t5-other";

const SESSION_USER = {
  id: USER_ID,
  email: "chef@example.com",
  name: "Mise Chef",
};

/** A row of the fake `User` table, in the columns these two callers select. */
interface UserRow {
  id: string;
  email: string;
  name: string | null;
  timezone: string;
  timezoneSource: TimezoneSource;
}

/**
 * The fake table, fresh per test because the update double writes through it.
 * The session user starts on the column default (`UTC`, `DETECTED`) — the
 * state a user who has never opened settings is in — and the other user starts
 * on a zone and a source that differ in both fields, so a leak between rows
 * shows up as a value rather than as a missing one.
 */
function userTable(): UserRow[] {
  return [
    {
      ...SESSION_USER,
      timezone: "UTC",
      timezoneSource: "DETECTED",
    },
    {
      id: OTHER_USER_ID,
      email: "someone@example.com",
      name: "Someone Else",
      timezone: "Asia/Tokyo",
      timezoneSource: "EXPLICIT",
    },
  ];
}

let users: UserRow[] = [];

/** Every `select` either caller sends, as the double sees it. */
type Select = Record<string, true>;

interface FindArgs {
  where: { id: string };
  select: Select;
}

interface UpdateArgs {
  where: { id: string };
  // The explicit write sends both fields; the resume-detection write sends
  // only the source. The double writes what the statement names, nothing more.
  data: { timezone?: string; timezoneSource: TimezoneSource };
  select: Select;
}

/** The conditional detection write: no `select`, and no source in the `data`. */
interface UpdateManyArgs {
  where: { id: string; timezoneSource: TimezoneSource };
  data: { timezone: string };
}

/**
 * The settings statements, recorded in order. Separate from the identity
 * lookups `deserializeUser` makes, so "no statement ran" assertions are about
 * the endpoint rather than about being signed in.
 */
const reads: FindArgs[] = [];
const writes: UpdateArgs[] = [];
const detections: UpdateManyArgs[] = [];

function rowOf(id: string): UserRow | undefined {
  return users.find((user) => user.id === id);
}

function settingsOf(row: UserRow): Settings {
  return { timezone: row.timezone, timezoneSource: row.timezoneSource };
}

/**
 * `user.findUnique` for both callers. Which one is asking is read off the
 * `select`, and each is answered from the row the `where` names — so a
 * statement keyed by the wrong id is answered with the wrong row rather than
 * with the right one anyway.
 */
function findUniqueDouble(args: FindArgs): Promise<unknown> {
  const row = rowOf(args.where.id);

  if (args.select.timezone === true) {
    reads.push(args);

    return Promise.resolve(row === undefined ? null : settingsOf(row));
  }

  return Promise.resolve(
    row === undefined ? null : { id: row.id, email: row.email, name: row.name },
  );
}

/** `user.update`: writes through to the fake table and returns the stored row. */
function updateDouble(args: UpdateArgs): Promise<Settings> {
  writes.push(args);
  const row = rowOf(args.where.id);
  if (row === undefined) {
    // What Prisma does when a unique-keyed update matches nothing (`P2025`).
    return Promise.reject(new Error("record to update not found"));
  }

  if (args.data.timezone !== undefined) {
    row.timezone = args.data.timezone;
  }
  row.timezoneSource = args.data.timezoneSource;

  return Promise.resolve(settingsOf(row));
}

/**
 * `user.updateMany`: the detection write. Applies only to a row that matches
 * *every* condition in the `where`, as Postgres would — so a row the condition
 * misses is left alone here rather than being taken on trust by the assertion
 * — and writes only the fields named in `data`, which is how "the source stays
 * `DETECTED`" is a property of the statement rather than of this double.
 */
function updateManyDouble(args: UpdateManyArgs): Promise<{ count: number }> {
  detections.push(args);
  const row = rowOf(args.where.id);
  if (row === undefined || row.timezoneSource !== args.where.timezoneSource) {
    // No row matched: either there is none, or the one there has already been
    // claimed by an explicit choice. Prisma reports both as a count of 0.
    return Promise.resolve({ count: 0 });
  }

  row.timezone = args.data.timezone;

  return Promise.resolve({ count: 1 });
}

/**
 * The rollover's transaction: the house `(run) => run(tx)` shape. Its zone read
 * is answered from the same fake table, so a zone stored through the endpoint
 * is the zone the next request's rollover measures its day in.
 */
function runInTransaction<T>(
  run: (tx: {
    user: {
      findUnique: (args: FindArgs) => Promise<{ timezone: string } | null>;
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
    task: { updateMany: (args: unknown) => Promise<{ count: number }> };
  }) => Promise<T>,
): Promise<T> {
  return run({
    user: {
      findUnique: ({ where }) => {
        const row = rowOf(where.id);

        return Promise.resolve(
          row === undefined ? null : { timezone: row.timezone },
        );
      },
      updateMany: (args) => db.claimDay(args) as Promise<{ count: number }>,
    },
    task: {
      updateMany: () => Promise.resolve({ count: 0 }),
    },
  });
}

/** No settings statement reached the columns — read, write or detection. */
function expectNoSettingsStatement(): void {
  expect(reads).toHaveLength(0);
  expect(writes).toHaveLength(0);
  expect(detections).toHaveLength(0);
  expect(db.update).not.toHaveBeenCalled();
  expect(db.updateMany).not.toHaveBeenCalled();
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

/** Both sign-in legs with the success double; returns the cookie left over. */
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

describe("the settings router", () => {
  beforeEach(() => {
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

    users = userTable();
    reads.length = 0;
    writes.length = 0;
    detections.length = 0;

    for (const spy of [
      db.findUnique,
      db.update,
      db.updateMany,
      db.claimDay,
      db.transaction,
    ]) {
      spy.mockReset();
    }

    db.findUnique.mockImplementation(findUniqueDouble);
    db.update.mockImplementation(updateDouble);
    db.updateMany.mockImplementation(updateManyDouble);
    // Today's rollover is already done, so it claims nothing and defers
    // nothing. `services/rollover.test.ts` owns the other branch.
    db.claimDay.mockResolvedValue({ count: 0 });
    db.transaction.mockImplementation(runInTransaction);
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

  describe("the auth gate", () => {
    it("refuses an unauthenticated GET before any statement", async () => {
      const response = await request(buildApp()).get("/api/settings");

      expect(response.status).toBe(401);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(response.body).toEqual({ error: "Unauthorized" });
      // The gate is above the router, so a refusal costs no query at all —
      // not even the session lookup.
      expect(db.findUnique).not.toHaveBeenCalled();
      expectNoSettingsStatement();
    });

    it("refuses an unauthenticated PATCH ahead of the validator", async () => {
      const response = await request(buildApp())
        .patch("/api/settings")
        .send({ timezone: "Mars/Olympus_Mons" });

      // 401 rather than the 400 the body deserves: who is asking is settled
      // before what they sent, so an anonymous caller cannot probe the
      // validator.
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expectNoSettingsStatement();
    });

    it("refuses an unauthenticated PATCH with a valid body", async () => {
      const response = await request(buildApp())
        .patch("/api/settings")
        .send({ timezone: "America/Chicago" });

      expect(response.status).toBe(401);
      expectNoSettingsStatement();
      // And the table still holds the default.
      expect(rowOf(USER_ID)?.timezone).toBe("UTC");
    });

    it("refuses an unauthenticated detection write", async () => {
      const response = await request(buildApp())
        .patch("/api/settings/detected")
        .send({ timezone: "America/Chicago" });

      // The detection path is below the same gate as the rest: an anonymous
      // caller cannot nudge anyone's zone, conditional statement or not.
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expect(db.findUnique).not.toHaveBeenCalled();
      expectNoSettingsStatement();
      expect(rowOf(USER_ID)?.timezone).toBe("UTC");
    });

    it("refuses an unauthenticated detection write ahead of the validator", async () => {
      const response = await request(buildApp())
        .patch("/api/settings/detected")
        .send({ timezone: "Mars/Olympus_Mons" });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expectNoSettingsStatement();
    });
  });

  describe("reading", () => {
    it("answers the stored zone and its source, and nothing else", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .get("/api/settings")
        .set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      // Whole-body equality: an extra column reaching the wire fails here.
      expect(response.body).toEqual({
        timezone: "UTC",
        timezoneSource: "DETECTED",
      });
    });

    it("selects exactly the two DTO columns, keyed by the session's user", async () => {
      const { app, cookie } = await signedInApp();

      await request(app).get("/api/settings").set("Cookie", cookie).expect(200);

      expect(reads).toHaveLength(1);
      const read = reads[0];
      expect(Object.keys(read?.select ?? {}).sort()).toEqual([
        "timezone",
        "timezoneSource",
      ]);
      // The keys, not just the values: a `where` with a second condition is a
      // different statement even when the id matches.
      expect(Object.keys(read?.where ?? {})).toEqual(["id"]);
      expect(read?.where.id).toBe(USER_ID);
    });

    it("reads a zone the user already set explicitly", async () => {
      users = [
        {
          ...SESSION_USER,
          timezone: "America/Chicago",
          timezoneSource: "EXPLICIT",
        },
      ];
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .get("/api/settings")
        .set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        timezone: "America/Chicago",
        timezoneSource: "EXPLICIT",
      });
    });

    it("answers 500 without naming the user when the row is gone", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { app, cookie } = await signedInApp();
      // The row survives `deserializeUser` and is gone by the time the handler
      // asks for its settings — an out-of-band deletion mid-request. Not a
      // 404: there is no resource the client could create or correct.
      db.findUnique.mockImplementation((args: FindArgs) =>
        args.select.timezone === true
          ? Promise.resolve(null)
          : Promise.resolve(SESSION_USER),
      );

      const response = await request(app)
        .get("/api/settings")
        .set("Cookie", cookie);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal Server Error" });
      // Logged, but the line names no user: the service message is fixed text.
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.flat().join(" ");
      expect(logged).not.toContain(USER_ID);
      expect(logged).not.toContain(SESSION_USER.email);
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe("writing", () => {
    it("stores the zone as explicit and answers the stored settings", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/settings")
        .set("Cookie", cookie)
        .send({ timezone: "America/Chicago" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        timezone: "America/Chicago",
        timezoneSource: "EXPLICIT",
      });
      // `timezoneSource` is the server's to set, and `EXPLICIT` is the whole
      // point of the endpoint: detection must not overwrite a chosen zone.
      expect(db.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { timezone: "America/Chicago", timezoneSource: "EXPLICIT" },
        select: expect.anything(),
      });
      expect(Object.keys(writes[0]?.select ?? {}).sort()).toEqual([
        "timezone",
        "timezoneSource",
      ]);
      expect(Object.keys(writes[0]?.where ?? {})).toEqual(["id"]);
    });

    it("turns a DETECTED source explicit, visibly, and the next read agrees", async () => {
      const { app, cookie } = await signedInApp();

      const before = await request(app)
        .get("/api/settings")
        .set("Cookie", cookie);
      expect(before.body).toEqual({
        timezone: "UTC",
        timezoneSource: "DETECTED",
      });

      const patched = await request(app)
        .patch("/api/settings")
        .set("Cookie", cookie)
        .send({ timezone: "Asia/Tokyo" });

      // The transition is in the PATCH response, which is why this is a 200
      // with a body rather than a 204: the client learns the source turned
      // explicit without a second round trip.
      expect(patched.status).toBe(200);
      expect(patched.body).toEqual({
        timezone: "Asia/Tokyo",
        timezoneSource: "EXPLICIT",
      });

      const after = await request(app)
        .get("/api/settings")
        .set("Cookie", cookie);
      expect(after.body).toEqual(patched.body);
    });

    it("stores the trimmed zone the validator produced", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/settings")
        .set("Cookie", cookie)
        .send({ timezone: "  America/Chicago  " });

      expect(response.status).toBe(200);
      expect(response.body.timezone).toBe("America/Chicago");
      // The handler reads through the validator, so the untrimmed string never
      // reaches the column.
      expect(writes[0]?.data.timezone).toBe("America/Chicago");
    });

    it("refuses an unknown zone with a per-field message and no write", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/settings")
        .set("Cookie", cookie)
        .send({ timezone: "Mars/Olympus_Mons" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(Object.keys(response.body.fields)).toEqual(["timezone"]);
      // A zone ICU cannot resolve is refused here rather than 500-ing the next
      // rollover — and the refusal costs no write.
      expect(writes).toHaveLength(0);
      expect(db.update).not.toHaveBeenCalled();
      expect(rowOf(USER_ID)).toMatchObject({
        timezone: "UTC",
        timezoneSource: "DETECTED",
      });
    });

    it("refuses a body that names no field", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/settings")
        .set("Cookie", cookie)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: "Validation failed",
        fields: { timezone: expect.any(String) },
      });
      expect(db.update).not.toHaveBeenCalled();
    });

    it("refuses a PATCH with no body at all", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/settings")
        .set("Cookie", cookie);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(db.update).not.toHaveBeenCalled();
    });

    it("refuses a client-sent timezoneSource, valid zone and all", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/settings")
        .set("Cookie", cookie)
        .send({ timezone: "America/Chicago", timezoneSource: "DETECTED" });

      // `strictObject`, so the extra key is a 400 rather than a silent drop —
      // and the zone that came with it is not stored either, so the client
      // cannot half-succeed at claiming the source.
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(Object.keys(response.body.fields)).toEqual(["timezoneSource"]);
      expect(writes).toHaveLength(0);
      expect(rowOf(USER_ID)?.timezone).toBe("UTC");
      expect(rowOf(USER_ID)?.timezoneSource).toBe("DETECTED");
    });

    it.each([
      { label: "an unknown key", body: { timezone: "UTC", nope: true } },
      {
        label: "a user id",
        body: { timezone: "UTC", userId: OTHER_USER_ID },
      },
      { label: "a renamed field", body: { timeZone: "UTC" } },
    ])("refuses $label with no write", async ({ body }) => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/settings")
        .set("Cookie", cookie)
        .send(body);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(db.update).not.toHaveBeenCalled();
    });

    it.each([42, null, true, ["America/Chicago"]])(
      "refuses a non-string timezone (%j) with no write",
      async (timezone) => {
        const { app, cookie } = await signedInApp();

        const response = await request(app)
          .patch("/api/settings")
          .set("Cookie", cookie)
          .send({ timezone });

        expect(response.status).toBe(400);
        expect(response.body.fields).toHaveProperty("timezone");
        expect(db.update).not.toHaveBeenCalled();
      },
    );
  });

  describe("the detection write", () => {
    /** The statement the endpoint must issue, exactly and only. */
    const DETECTION_STATEMENT = {
      where: { id: USER_ID, timezoneSource: "DETECTED" },
      data: { timezone: "America/Chicago" },
    };

    it("stores the zone, leaves the source detected, and answers 204", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/settings/detected")
        .set("Cookie", cookie)
        .send({ timezone: "America/Chicago" });

      expect(response.status).toBe(204);
      expect(response.text).toBe("");
      // The whole statement, by equality: the condition is in the `where` (so
      // the no-op case needs no second query), the `data` names the zone and
      // *not* the source (so `DETECTED` survives by not being written), and
      // there is no `select` to leak a column.
      expect(db.updateMany).toHaveBeenCalledTimes(1);
      expect(db.updateMany).toHaveBeenCalledWith(DETECTION_STATEMENT);
      expect(rowOf(USER_ID)).toMatchObject({
        timezone: "America/Chicago",
        timezoneSource: "DETECTED",
      });
      // No `update` anywhere near it: the explicit write is the only caller of
      // that statement, and it is the one that would have said `EXPLICIT`.
      expect(db.update).not.toHaveBeenCalled();
    });

    it("is visible to the next read, still as a detected zone", async () => {
      const { app, cookie } = await signedInApp();

      await request(app)
        .patch("/api/settings/detected")
        .set("Cookie", cookie)
        .send({ timezone: "America/Chicago" })
        .expect(204);

      const after = await request(app)
        .get("/api/settings")
        .set("Cookie", cookie);

      expect(after.status).toBe(200);
      expect(after.body).toEqual({
        timezone: "America/Chicago",
        timezoneSource: "DETECTED",
      });
    });

    it("keeps following a travelling user across sign-ins", async () => {
      const { app, cookie } = await signedInApp();

      // The regression this endpoint exists for: a first detection must not be
      // mistaken for a choice, or the zone freezes wherever the user happened
      // to sign in first and never moves again.
      for (const timezone of ["America/Chicago", "Europe/London", "UTC"]) {
        await request(app)
          .patch("/api/settings/detected")
          .set("Cookie", cookie)
          .send({ timezone })
          .expect(204);

        expect(rowOf(USER_ID)).toMatchObject({
          timezone,
          timezoneSource: "DETECTED",
        });
      }

      // Every one of them went through the same condition — none of them
      // turned it off.
      expect(detections.map((args) => args.where.timezoneSource)).toEqual([
        "DETECTED",
        "DETECTED",
        "DETECTED",
      ]);
    });

    it("is a no-op on an explicit choice, and still a 204", async () => {
      users = [
        {
          ...SESSION_USER,
          timezone: "Asia/Tokyo",
          timezoneSource: "EXPLICIT",
        },
      ];
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/settings/detected")
        .set("Cookie", cookie)
        .send({ timezone: "America/Chicago" });

      // 204, not a 409: a client that detects a zone every sign-in is not
      // doing anything wrong by offering one the user has overridden, and it
      // has nothing to retry.
      expect(response.status).toBe(204);
      expect(response.text).toBe("");
      // The statement ran and matched nothing — the condition did the refusing,
      // so the column never saw the detected zone.
      expect(db.updateMany).toHaveBeenCalledTimes(1);
      expect(detections[0]?.where).toEqual({
        id: USER_ID,
        timezoneSource: "DETECTED",
      });
      expect(rowOf(USER_ID)).toMatchObject({
        timezone: "Asia/Tokyo",
        timezoneSource: "EXPLICIT",
      });
    });

    it("cannot undo an explicit save made in the same session", async () => {
      const { app, cookie } = await signedInApp();

      await request(app)
        .patch("/api/settings")
        .set("Cookie", cookie)
        .send({ timezone: "Asia/Tokyo" })
        .expect(200);
      await request(app)
        .patch("/api/settings/detected")
        .set("Cookie", cookie)
        .send({ timezone: "America/Chicago" })
        .expect(204);

      const after = await request(app)
        .get("/api/settings")
        .set("Cookie", cookie);

      // End to end, in the order a user actually hits it: pick a zone in
      // settings, then let the next page load detect the browser's. The
      // chosen one stands.
      expect(after.body).toEqual({
        timezone: "Asia/Tokyo",
        timezoneSource: "EXPLICIT",
      });
    });

    it("stores the trimmed zone the validator produced", async () => {
      const { app, cookie } = await signedInApp();

      await request(app)
        .patch("/api/settings/detected")
        .set("Cookie", cookie)
        .send({ timezone: "  America/Chicago  " })
        .expect(204);

      expect(detections[0]?.data.timezone).toBe("America/Chicago");
      expect(rowOf(USER_ID)?.timezone).toBe("America/Chicago");
    });

    it("refuses an unknown zone with a per-field message and no write", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/settings/detected")
        .set("Cookie", cookie)
        .send({ timezone: "Mars/Olympus_Mons" });

      // Same validation as the explicit write: whatever the browser reports,
      // a zone ICU cannot resolve must not reach the column that
      // `services/rollover.ts` measures a day in.
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(Object.keys(response.body.fields)).toEqual(["timezone"]);
      expect(detections).toHaveLength(0);
      expect(db.updateMany).not.toHaveBeenCalled();
      expect(rowOf(USER_ID)).toMatchObject({
        timezone: "UTC",
        timezoneSource: "DETECTED",
      });
    });

    it.each([
      { label: "a body that names no field", body: {} },
      { label: "an unknown key", body: { timezone: "UTC", nope: true } },
      { label: "a renamed field", body: { timeZone: "UTC" } },
      {
        label: "a client-sent timezoneSource",
        body: { timezone: "America/Chicago", timezoneSource: "EXPLICIT" },
      },
      { label: "a non-string timezone", body: { timezone: 42 } },
    ])("refuses $label with no write", async ({ body }) => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/settings/detected")
        .set("Cookie", cookie)
        .send(body);

      // `strictObject` here too — and `timezoneSource` is no more the client's
      // to send on this endpoint than on the other one, even though the only
      // value this endpoint could store is the one it also requires.
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(db.updateMany).not.toHaveBeenCalled();
      expect(rowOf(USER_ID)?.timezone).toBe("UTC");
    });

    it("refuses a detection write with no body at all", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/settings/detected")
        .set("Cookie", cookie);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(db.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("resuming detection", () => {
    /** The session user after an explicit choice — the state the way back is for. */
    function armExplicitUser(): void {
      users = [
        {
          ...SESSION_USER,
          timezone: "America/Chicago",
          timezoneSource: "EXPLICIT",
        },
      ];
    }

    it("refuses an unauthenticated POST before any statement", async () => {
      const response = await request(buildApp()).post(
        "/api/settings/resume-detection",
      );

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expect(db.findUnique).not.toHaveBeenCalled();
      expectNoSettingsStatement();
    });

    it("turns an explicit source back to DETECTED and keeps the zone", async () => {
      armExplicitUser();
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .post("/api/settings/resume-detection")
        .set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        timezone: "America/Chicago",
        timezoneSource: "DETECTED",
      });
      // The statement names only the source: the zone is not part of this
      // write at all, which is what "keeps the zone" rests on.
      expect(db.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { timezoneSource: "DETECTED" },
        select: expect.anything(),
      });
      expect(Object.keys(writes[0]?.where ?? {})).toEqual(["id"]);
      expect(Object.keys(writes[0]?.data ?? {})).toEqual(["timezoneSource"]);
    });

    it("reopens the detection path it hands the zone back to", async () => {
      armExplicitUser();
      const { app, cookie } = await signedInApp();

      // Detection is shut while the source is EXPLICIT…
      await request(app)
        .patch("/api/settings/detected")
        .set("Cookie", cookie)
        .send({ timezone: "Asia/Tokyo" });
      expect(rowOf(USER_ID)?.timezone).toBe("America/Chicago");

      // …and open again after the way back, with the source still DETECTED.
      await request(app)
        .post("/api/settings/resume-detection")
        .set("Cookie", cookie);
      await request(app)
        .patch("/api/settings/detected")
        .set("Cookie", cookie)
        .send({ timezone: "Asia/Tokyo" });

      const after = await request(app)
        .get("/api/settings")
        .set("Cookie", cookie);
      expect(after.body).toEqual({
        timezone: "Asia/Tokyo",
        timezoneSource: "DETECTED",
      });
    });

    it("is a no-op shaped 200 for a source that is already DETECTED", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .post("/api/settings/resume-detection")
        .set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        timezone: "UTC",
        timezoneSource: "DETECTED",
      });
    });

    it("writes only the session user's row", async () => {
      armExplicitUser();
      users.push({
        id: OTHER_USER_ID,
        email: "someone@example.com",
        name: "Someone Else",
        timezone: "Asia/Tokyo",
        timezoneSource: "EXPLICIT",
      });
      const { app, cookie } = await signedInApp();

      await request(app)
        .post("/api/settings/resume-detection")
        .set("Cookie", cookie);

      expect(writes).toHaveLength(1);
      expect(writes[0]?.where).toEqual({ id: USER_ID });
      const other = rowOf(OTHER_USER_ID);
      expect(other?.timezoneSource).toBe("EXPLICIT");
      expect(other?.timezone).toBe("Asia/Tokyo");
    });

    it("answers 500 without naming the user when the row is gone", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      armExplicitUser();
      const { app, cookie } = await signedInApp();
      // Row gone between `deserializeUser` and the write — Prisma's P2025.
      db.update.mockRejectedValue(new Error("record to update not found"));

      const response = await request(app)
        .post("/api/settings/resume-detection")
        .set("Cookie", cookie);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal Server Error" });
      const logged = errorSpy.mock.calls.flat().join(" ");
      expect(logged).not.toContain(USER_ID);
      expect(logged).not.toContain(SESSION_USER.email);
    });
  });

  describe("cross-user isolation", () => {
    it("reads the session user's row, never another's", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .get("/api/settings")
        .set("Cookie", cookie);

      expect(response.status).toBe(200);
      // The other row holds `Asia/Tokyo`/`EXPLICIT`; nothing of it appears.
      expect(response.body).toEqual({
        timezone: "UTC",
        timezoneSource: "DETECTED",
      });
      expect(reads.map((read) => read.where.id)).toEqual([USER_ID]);
    });

    it("writes the session user's row, whatever the body says", async () => {
      const { app, cookie } = await signedInApp();

      const response = await request(app)
        .patch("/api/settings")
        .set("Cookie", cookie)
        .send({ timezone: "Europe/London" });

      expect(response.status).toBe(200);
      expect(writes.map((write) => write.where.id)).toEqual([USER_ID]);
      expect(rowOf(USER_ID)).toMatchObject({
        timezone: "Europe/London",
        timezoneSource: "EXPLICIT",
      });
      // Untouched, in both columns.
      expect(rowOf(OTHER_USER_ID)).toMatchObject({
        timezone: "Asia/Tokyo",
        timezoneSource: "EXPLICIT",
      });
    });

    it("writes only the session user's row on a detection write", async () => {
      // Both rows detected, on different zones: an `updateMany` that forgot
      // the id and kept only the source condition would match both, which is
      // precisely the mistake this statement shape invites.
      users = [
        { ...SESSION_USER, timezone: "UTC", timezoneSource: "DETECTED" },
        {
          id: OTHER_USER_ID,
          email: "someone@example.com",
          name: "Someone Else",
          timezone: "Asia/Tokyo",
          timezoneSource: "DETECTED",
        },
      ];
      const { app, cookie } = await signedInApp();

      await request(app)
        .patch("/api/settings/detected")
        .set("Cookie", cookie)
        .send({ timezone: "Europe/London" })
        .expect(204);

      expect(detections.map((args) => args.where.id)).toEqual([USER_ID]);
      expect(rowOf(USER_ID)?.timezone).toBe("Europe/London");
      expect(rowOf(OTHER_USER_ID)?.timezone).toBe("Asia/Tokyo");
    });

    it("carries the session user's id on every settings statement", async () => {
      const { app, cookie } = await signedInApp();

      await request(app).get("/api/settings").set("Cookie", cookie).expect(200);
      await request(app)
        .patch("/api/settings/detected")
        .set("Cookie", cookie)
        .send({ timezone: "Europe/Paris" })
        .expect(204);
      await request(app)
        .patch("/api/settings")
        .set("Cookie", cookie)
        .send({ timezone: "Europe/London" })
        .expect(200);
      await request(app).get("/api/settings").set("Cookie", cookie).expect(200);

      // The project rule, asserted as a rule rather than per statement: no
      // statement this endpoint issues is unscoped, and none names a user the
      // client chose.
      const scopes = [...reads, ...writes, ...detections].map(
        (args) => args.where.id,
      );
      // Two reads, one explicit write, one detection write — neither PATCH
      // re-reads.
      expect(scopes).toHaveLength(4);
      expect(new Set(scopes)).toEqual(new Set([USER_ID]));
      // And the detection write carries its condition as well as the id: the
      // scoping is the `id`, the semantics are the `timezoneSource`, and
      // dropping either one is a different statement.
      expect(detections.map((args) => Object.keys(args.where).sort())).toEqual([
        ["id", "timezoneSource"],
      ]);
      expect(detections[0]?.where.timezoneSource).toBe("DETECTED");
    });
  });

  describe("the stored zone the rollover then uses", () => {
    it("measures the next request's day in the zone just stored", async () => {
      // A fixed instant where the two zones disagree about the date: 20:00 UTC
      // on the 11th is 05:00 on the *12th* in Tokyo. Only `Date` is faked —
      // supertest and the session middleware keep their real timers.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-11T20:00:00.000Z"));
      try {
        const { app, cookie } = await signedInApp();
        // Not yet rolled over today, so the claim matches and records the day.
        db.claimDay.mockResolvedValue({ count: 1 });

        await request(app)
          .patch("/api/settings")
          .set("Cookie", cookie)
          .send({ timezone: "Asia/Tokyo" })
          .expect(200);
        await request(app)
          .get("/api/settings")
          .set("Cookie", cookie)
          .expect(200);

        const claims = db.claimDay.mock.calls.map(
          (call) =>
            (
              call[0] as {
                where: { id: string };
                data: { lastRolloverOn: Date };
              }
            ).data.lastRolloverOn,
        );
        // Two authenticated requests, two rollover claims. The PATCH's own
        // rollover ran before the write, so it still measured UTC — the 11th;
        // the GET that followed measured Tokyo — the 12th. This is the
        // end-to-end point of the feature: the stored column, not the server's
        // zone, decides where the day ends.
        expect(claims).toHaveLength(2);
        expect(claims[0]).toEqual(new Date("2026-11-11T00:00:00.000Z"));
        expect(claims[1]).toEqual(new Date("2026-11-12T00:00:00.000Z"));
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
