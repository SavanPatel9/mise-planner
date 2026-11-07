import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { describe, expect, it } from "vitest";
import request from "supertest";

import { AppError } from "../errors.js";
import { errorHandler } from "./errorHandler.js";
import {
  createRateLimit,
  DEFAULT_GENERAL_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_MAX_KEYS,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  MAX_RATE_LIMIT_KEY_LENGTH,
  type RateLimitOptions,
} from "./rateLimit.js";

const IP = "203.0.113.7";
const OTHER_IP = "198.51.100.42";

/** The header Vercel sets at its edge; a client cannot forge it. */
const EDGE_HEADER = "x-vercel-forwarded-for";

/**
 * A clock a test can step, so a window boundary is crossed in microseconds
 * rather than ten minutes.
 */
function fakeClock(start = 1_700_000_000_000) {
  let at = start;

  return {
    now: () => at,
    advance(ms: number) {
      at += ms;
    },
  };
}

/**
 * Drives the limiter without HTTP and reports what it passed to `next` —
 * `null` for an allowed request, the error for a refused one — alongside the
 * headers it set. `ip` is left off deliberately in one test: `req.ip` is
 * genuinely `undefined` when the socket has no readable remote address.
 */
function hit(
  limit: RequestHandler,
  ip?: string,
  headers: Record<string, string | string[]> = {},
): { passed: unknown; headers: Record<string, string> } {
  const calls: unknown[] = [];
  const next = ((error?: unknown) => {
    calls.push(error ?? null);
  }) as NextFunction;

  const set: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) {
      set[name] = value;
    },
  } as unknown as Response;

  limit({ ip, headers } as unknown as Request, res, next);

  // A limiter that forgot to call `next`, or called it twice, would hang or
  // double-answer a real request.
  expect(calls).toHaveLength(1);

  return { passed: calls[0], headers: set };
}

function expectAllowed(
  limit: RequestHandler,
  ip?: string,
  headers?: Record<string, string | string[]>,
): void {
  const allowed = hit(limit, ip, headers);

  expect(allowed.passed).toBeNull();
  // Nothing to wait for, so nothing to advertise.
  expect(allowed.headers["Retry-After"]).toBeUndefined();
}

/** Returns the `Retry-After` the refusal carried, for tests that check it. */
function expectRefused(
  limit: RequestHandler,
  ip?: string,
  headers?: Record<string, string | string[]>,
): string | undefined {
  const refused = hit(limit, ip, headers);

  expect(refused.passed).toBeInstanceOf(AppError);
  expect((refused.passed as AppError).status).toBe(429);
  // The message is what the error handler puts on the wire for a 4xx, so it
  // must stay the bare reason phrase.
  expect((refused.passed as AppError).message).toBe("Too Many Requests");

  return refused.headers["Retry-After"];
}

/** Minimal app, so the limiter is covered independently of `createApp`. */
function buildApp(options: RateLimitOptions): Express {
  const app = express();

  // One proxy hop, as in production: that is what makes `X-Forwarded-For`
  // decide `req.ip`, and so what makes the bucket key per-client.
  app.set("trust proxy", 1);
  app.use(createRateLimit(options));

  app.get("/thing", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(errorHandler);

  return app;
}

describe("createRateLimit", () => {
  it("allows exactly `max` requests per window and refuses the next", () => {
    const clock = fakeClock();
    const limit = createRateLimit({ max: 3, windowMs: 1000, now: clock.now });

    expectAllowed(limit, IP);
    expectAllowed(limit, IP);
    expectAllowed(limit, IP);
    expectRefused(limit, IP);
  });

  it("allows a single request through a max of 1", () => {
    const clock = fakeClock();
    const limit = createRateLimit({ max: 1, windowMs: 1000, now: clock.now });

    expectAllowed(limit, IP);
    expectRefused(limit, IP);
  });

  it("keeps refusing for the rest of the window", () => {
    const clock = fakeClock();
    const limit = createRateLimit({ max: 2, windowMs: 1000, now: clock.now });

    expectAllowed(limit, IP);
    expectAllowed(limit, IP);

    clock.advance(500);
    expectRefused(limit, IP);
    expectRefused(limit, IP);
  });

  it("starts a fresh window, with a full budget, once the old one expires", () => {
    const clock = fakeClock();
    const limit = createRateLimit({ max: 2, windowMs: 1000, now: clock.now });

    expectAllowed(limit, IP);
    expectAllowed(limit, IP);
    expectRefused(limit, IP);

    // Just short of the boundary the old window still holds.
    clock.advance(999);
    expectRefused(limit, IP);

    // The window is fixed, not sliding: hammering it while refused must not
    // push the expiry out, so the budget returns on schedule and in full.
    clock.advance(1);
    expectAllowed(limit, IP);
    expectAllowed(limit, IP);
    expectRefused(limit, IP);
  });

  it("counts each IP separately", () => {
    const clock = fakeClock();
    const limit = createRateLimit({ max: 2, windowMs: 1000, now: clock.now });

    expectAllowed(limit, IP);
    expectAllowed(limit, IP);
    expectRefused(limit, IP);

    // One noisy client must not lock everyone else out.
    expectAllowed(limit, OTHER_IP);
    expectAllowed(limit, OTHER_IP);
    expectRefused(limit, OTHER_IP);
  });

  it("shares one bucket for requests with no readable IP", () => {
    const clock = fakeClock();
    const limit = createRateLimit({ max: 2, windowMs: 1000, now: clock.now });

    // Stricter than exempting them: an address-less request is counted, and
    // counted together with every other address-less request.
    expectAllowed(limit);
    expectAllowed(limit);
    expectRefused(limit);

    // And it is its own bucket, not a wildcard that spends everyone's budget.
    expectAllowed(limit, IP);
  });

  it("gives every limiter its own counters", () => {
    const clock = fakeClock();
    const options = { max: 1, windowMs: 1000, now: clock.now };
    const first = createRateLimit(options);
    const second = createRateLimit(options);

    expectAllowed(first, IP);
    expectRefused(first, IP);

    // Two mounts (or two `createApp` calls in a test file) never share a budget.
    expectAllowed(second, IP);
    expectRefused(second, IP);
  });

  it("refuses a new key once the key cap is reached", () => {
    const clock = fakeClock();
    const limit = createRateLimit({
      max: 10,
      windowMs: 1000,
      maxKeys: 2,
      now: clock.now,
    });

    expectAllowed(limit, IP);
    expectAllowed(limit, OTHER_IP);

    // The map is full and nothing has expired, so a third address cannot be
    // tracked — and an untracked request is refused, not waved through.
    expectRefused(limit, "192.0.2.1");
    expectRefused(limit, "192.0.2.2");

    // Clients already in the map keep their budget: the cap sheds new keys,
    // not existing ones.
    expectAllowed(limit, IP);
    expectAllowed(limit, OTHER_IP);
  });

  it("takes a key slot back once its window expires", () => {
    const clock = fakeClock();
    const limit = createRateLimit({
      max: 10,
      windowMs: 1000,
      maxKeys: 1,
      now: clock.now,
    });

    expectAllowed(limit, IP);
    expectRefused(limit, OTHER_IP);

    // The prune runs before the cap check, so a cap hit is never permanent:
    // once the held window lapses, the slot is free for whoever arrives next.
    clock.advance(1000);
    expectAllowed(limit, OTHER_IP);
    expectRefused(limit, IP);
  });

  it("defaults to 20 requests per 10 minutes and 10k tracked keys", () => {
    expect(DEFAULT_RATE_LIMIT_MAX).toBe(20);
    expect(DEFAULT_RATE_LIMIT_WINDOW_MS).toBe(10 * 60 * 1000);
    expect(DEFAULT_RATE_LIMIT_MAX_KEYS).toBe(10_000);

    // No options at all: the real clock, and the defaults above.
    const limit = createRateLimit();

    for (let i = 0; i < DEFAULT_RATE_LIMIT_MAX; i += 1) {
      expectAllowed(limit, IP);
    }
    expectRefused(limit, IP);
  });

  it("offers a general budget far above what one client can need", () => {
    // Sized for the session-store round trip every `/api` request costs, not
    // for one route's abuse, so it has to clear ordinary use by a wide margin.
    expect(DEFAULT_GENERAL_RATE_LIMIT_MAX).toBe(600);
    expect(DEFAULT_GENERAL_RATE_LIMIT_MAX).toBeGreaterThan(
      DEFAULT_RATE_LIMIT_MAX,
    );

    const limit = createRateLimit({ max: DEFAULT_GENERAL_RATE_LIMIT_MAX });

    for (let i = 0; i < DEFAULT_GENERAL_RATE_LIMIT_MAX; i += 1) {
      expectAllowed(limit, IP);
    }
    expectRefused(limit, IP);
  });

  describe("the bucket key", () => {
    it("prefers the edge header over req.ip", () => {
      const clock = fakeClock();
      const limit = createRateLimit({ max: 1, windowMs: 1000, now: clock.now });

      // `req.ip` is the last `X-Forwarded-For` element verbatim under
      // `trust proxy: 1`, so a surviving client-supplied header would let the
      // caller pick its own bucket. The edge header is set by Vercel and wins.
      expectAllowed(limit, OTHER_IP, { [EDGE_HEADER]: IP });
      expectRefused(limit, "192.0.2.99", { [EDGE_HEADER]: IP });

      // Same claimed `req.ip`, different edge address: a separate bucket, so
      // the key really is the edge's and not the request's own.
      expectAllowed(limit, "192.0.2.99", { [EDGE_HEADER]: OTHER_IP });
    });

    it("takes the first address when the edge header carries several", () => {
      const clock = fakeClock();
      const limit = createRateLimit({ max: 1, windowMs: 1000, now: clock.now });

      // A comma-separated list and a repeated header are the same thing to
      // Node, which only collapses some headers into arrays.
      expectAllowed(limit, undefined, { [EDGE_HEADER]: `${IP}, 10.0.0.1` });
      expectRefused(limit, undefined, { [EDGE_HEADER]: [IP, OTHER_IP] });
    });

    it("falls back to req.ip, then to one shared bucket", () => {
      const clock = fakeClock();
      const limit = createRateLimit({ max: 1, windowMs: 1000, now: clock.now });

      // Local dev has no edge in front of it; an empty header is not an address.
      expectAllowed(limit, IP, { [EDGE_HEADER]: "" });
      expectRefused(limit, IP);

      // And a request with neither is counted, not exempted.
      expectAllowed(limit);
      expectRefused(limit);
    });

    it("truncates the key so a long header cannot claim memory", () => {
      const clock = fakeClock();
      const limit = createRateLimit({ max: 1, windowMs: 1000, now: clock.now });

      expect(MAX_RATE_LIMIT_KEY_LENGTH).toBe(100);

      const prefix = "9".repeat(MAX_RATE_LIMIT_KEY_LENGTH);
      const first = `${prefix}${"a".repeat(100)}`;
      const second = `${prefix}${"b".repeat(100)}`;

      // `maxKeys` bounds how many buckets exist, not how many bytes each holds;
      // headers run to kilobytes, so the key is cut to a fixed length. Two keys
      // sharing a prefix therefore share a bucket — a merge, which over-refuses
      // rather than exempting.
      expectAllowed(limit, undefined, { [EDGE_HEADER]: first });
      expectRefused(limit, undefined, { [EDGE_HEADER]: second });
    });

    it("can be overridden", () => {
      const clock = fakeClock();
      const limit = createRateLimit({
        max: 1,
        windowMs: 1000,
        now: clock.now,
        keyFor: () => "everyone",
      });

      // One bucket for every caller: not a configuration to ship, but proof the
      // derivation is the only thing deciding the key.
      expectAllowed(limit, IP);
      expectRefused(limit, OTHER_IP);
    });
  });

  describe("Retry-After", () => {
    it("reports the seconds left in the window, rounded up", () => {
      const clock = fakeClock();
      const limit = createRateLimit({
        max: 1,
        windowMs: 10_000,
        now: clock.now,
      });

      expectAllowed(limit, IP);
      expect(expectRefused(limit, IP)).toBe("10");

      // 7.5s left rounds up to 8: never advertise a wait shorter than the real
      // one, or the client retries into another refusal.
      clock.advance(2500);
      expect(expectRefused(limit, IP)).toBe("8");
    });

    it("never advertises a wait below one second", () => {
      const clock = fakeClock();
      const limit = createRateLimit({ max: 1, windowMs: 1000, now: clock.now });

      expectAllowed(limit, IP);

      // A sliver of the window is left; "Retry-After: 0" would read as "now".
      clock.advance(999);
      expect(expectRefused(limit, IP)).toBe("1");
    });

    it("reports the whole window when the key cap refuses a new client", () => {
      const clock = fakeClock();
      const limit = createRateLimit({
        max: 10,
        windowMs: 30_000,
        maxKeys: 1,
        now: clock.now,
      });

      expectAllowed(limit, IP);

      // No window of its own to read, so the window length is the honest
      // upper bound on how long the held slots can stay held.
      expect(expectRefused(limit, OTHER_IP)).toBe("30");
    });
  });

  it("answers a refused request with the 429 error envelope", async () => {
    const app = buildApp({ max: 1, windowMs: 1000 });

    const allowed = await request(app).get("/thing");
    expect(allowed.status).toBe(200);

    const refused = await request(app).get("/thing");

    expect(refused.status).toBe(429);
    expect(refused.headers["content-type"]).toMatch(/application\/json/);
    expect(refused.body).toEqual({ error: "Too Many Requests" });
    // Set before the error is handed on, and the error handler writes no
    // headers of its own, so it survives onto the wire.
    expect(refused.headers["retry-after"]).toBe("1");
    // The limit says nothing about who is limited or for how long.
    expect(refused.text).not.toContain("127.0.0.1");
  });

  it("keys a forwarded request on the client address, not the proxy's", async () => {
    const app = buildApp({ max: 1, windowMs: 1000 });

    await request(app).get("/thing").set("X-Forwarded-For", IP).expect(200);
    await request(app).get("/thing").set("X-Forwarded-For", IP).expect(429);

    // Same socket, different client: behind a single proxy every request would
    // otherwise share one bucket.
    await request(app)
      .get("/thing")
      .set("X-Forwarded-For", OTHER_IP)
      .expect(200);
  });

  it("ignores a client-supplied X-Forwarded-For when the edge header is set", async () => {
    const app = buildApp({ max: 1, windowMs: 1000 });

    await request(app)
      .get("/thing")
      .set("X-Vercel-Forwarded-For", IP)
      .set("X-Forwarded-For", "10.0.0.1")
      .expect(200);

    // A caller cycling `X-Forwarded-For` would otherwise get a fresh budget per
    // request, and could fill `maxKeys` to lock the real client out.
    await request(app)
      .get("/thing")
      .set("X-Vercel-Forwarded-For", IP)
      .set("X-Forwarded-For", "10.0.0.2")
      .expect(429);
  });
});
