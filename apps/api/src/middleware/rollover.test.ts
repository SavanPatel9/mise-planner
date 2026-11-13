import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The service is the double here: this file is about what the middleware does
// with the service's outcome, not about the rollover itself
// (`services/rollover.test.ts` owns that). The spy lives outside the factory
// (`vi.hoisted`) so each test can re-arm it.
const service = vi.hoisted(() => ({ rolloverIfNeeded: vi.fn() }));

vi.mock("../services/rollover.js", () => ({
  rolloverIfNeeded: service.rolloverIfNeeded,
}));

import { errorHandler } from "./errorHandler.js";
import { rollover } from "./rollover.js";

const USER_ID = "user-cuid-m3t3-mw";

// A distinctive string so its appearance in — or absence from — a log line is
// unambiguous. Shaped like the kind of message a Prisma failure carries.
const INTERNAL_SENTINEL = "pg-connection-string-leak-4e17";

let errorSpy: ReturnType<typeof vi.spyOn>;

/**
 * Stands in for the stack below the gate: a middleware that attaches
 * `req.auth` the way `requireAuth` does, the real rollover middleware, a
 * handler that reports whether the rollover had already settled when it ran,
 * and the real error handler so an escaping error shows up as a 500.
 */
function buildApp(options: { userId?: string } = {}): Express {
  const { userId = USER_ID } = options;
  const app = express();

  app.use((req, _res, next) => {
    if (userId !== "") {
      req.auth = { userId };
    }
    next();
  });

  app.use(rollover);

  app.get("/thing", (_req, res) => {
    res.json({ ok: true, settled });
  });

  app.use(errorHandler);

  return app;
}

/** Set by the slow-service double below once its promise has resolved. */
let settled = false;

describe("the rollover middleware", () => {
  beforeEach(() => {
    settled = false;
    service.rolloverIfNeeded.mockReset();
    service.rolloverIfNeeded.mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries the rollover for the session's user and continues", async () => {
    const before = Date.now();

    const response = await request(buildApp()).get("/thing");

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(service.rolloverIfNeeded).toHaveBeenCalledTimes(1);
    const [userId, now] = service.rolloverIfNeeded.mock.calls[0] as [
      string,
      Date,
    ];
    // The id comes from the session via `requireAuth`, never from the request.
    expect(userId).toBe(USER_ID);
    // And the clock is the server's now, not a value the caller can name.
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("awaits the rollover before the handler runs", async () => {
    service.rolloverIfNeeded.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            settled = true;
            resolve();
          }, 10);
        }),
    );

    const response = await request(buildApp()).get("/thing");

    expect(response.status).toBe(200);
    // The point of awaiting: a handler below must read post-rollover
    // `deferCount`s rather than the previous day's.
    expect(response.body.settled).toBe(true);
  });

  it("serves the request anyway when the rollover rejects", async () => {
    service.rolloverIfNeeded.mockRejectedValue(
      new Error(`rollover tx failed ${INTERNAL_SENTINEL}`),
    );

    const response = await request(buildApp()).get("/thing");

    // Bookkeeping must never cost the caller their response.
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("serves the request anyway when the rollover throws a non-Error", async () => {
    service.rolloverIfNeeded.mockImplementation(() => {
      // Not every throw is an Error, and a thrown string has no `.message`.
      throw `string throw ${INTERNAL_SENTINEL}`;
    });

    const response = await request(buildApp()).get("/thing");

    expect(response.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(loggedText()).toContain(INTERNAL_SENTINEL);
  });

  it("logs the message only, with no user id and no stack", async () => {
    service.rolloverIfNeeded.mockRejectedValue(
      new Error(`rollover tx failed ${INTERNAL_SENTINEL}`),
    );

    const response = await request(buildApp()).get("/thing");
    expect(response.status).toBe(200);

    const logged = loggedText();
    expect(logged).toContain("rollover failed");
    expect(logged).toContain(INTERNAL_SENTINEL);
    // No request detail and no user id: the log is one line about a failure,
    // not a record of who made the request.
    expect(logged).not.toContain(USER_ID);
    expect(logged).not.toContain("/thing");
    // The Error itself is never handed to `console.error`, so no stack can
    // reach the log through it.
    for (const argument of loggedParts()) {
      expect(argument).not.toBeInstanceOf(Error);
    }
  });

  it("escapes control characters in the logged message", async () => {
    service.rolloverIfNeeded.mockRejectedValue(
      new Error(`line one\nline two ${INTERNAL_SENTINEL}`),
    );

    await request(buildApp()).get("/thing").expect(200);

    const logged = loggedText();
    // A newline in a Prisma message must not forge a second log line.
    expect(logged).toContain("\\u000a");
    expect(logged).not.toContain("\n");
  });

  it("fails loudly when it is mounted above the gate", async () => {
    // `userIdOf` throws when `req.auth` is missing, and it sits outside the
    // forgiving `try` on purpose: a mount-order bug must surface as a 500,
    // not dissolve into the rollover's log-and-continue path.
    const response = await request(buildApp({ userId: "" })).get("/thing");

    expect(response.status).toBe(500);
    expect(service.rolloverIfNeeded).not.toHaveBeenCalled();
  });
});

/** The arguments the one `console.error` call was given. */
function loggedParts(): unknown[] {
  expect(errorSpy).toHaveBeenCalled();
  const calls = errorSpy.mock.calls as unknown[][];

  return calls[0] ?? [];
}

/** Those arguments joined, for searching. */
function loggedText(): string {
  return loggedParts()
    .map((part) => String(part))
    .join(" ");
}
