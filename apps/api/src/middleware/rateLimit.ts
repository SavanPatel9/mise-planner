// A fixed-window, per-client request limiter with no dependencies and no store.
//
// Its one limitation, stated plainly: the counters live in this process's
// memory. Vercel Functions are ephemeral and horizontally scaled, so a limit
// holds only for the instance that happens to serve the request, resets on a
// cold start, and is multiplied by the number of warm instances. That makes it
// a best-effort mitigation — it blunts a single scripted loop hammering the
// session store, whether through `/api/auth/*` sign-in writes or through the
// get-and-touch every cookie-bearing `/api` request costs — and never a
// security control. Anything that must actually hold needs shared state
// (Postgres or a KV store).
import type { Request, RequestHandler, Response } from "express";

import { AppError } from "../errors.js";

/** Requests allowed per client per window on `/api/auth`, absent an override. */
export const DEFAULT_RATE_LIMIT_MAX = 20;

/**
 * Requests allowed per client per window across `/api` as a whole. Generous by
 * design: this budget is not about abuse of any one route but about the
 * session-store round trip every cookie-bearing request pays, so it has to sit
 * far above anything the web app does in ten minutes while still capping a
 * scripted loop.
 */
export const DEFAULT_GENERAL_RATE_LIMIT_MAX = 600;

/** Window length, absent an override: 10 minutes. */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Distinct keys tracked at once, absent an override. Bounds both the memory a
 * flood of distinct clients can claim and the per-request prune scan.
 */
export const DEFAULT_RATE_LIMIT_MAX_KEYS = 10_000;

/**
 * Characters of a derived key that are kept. The headers a key comes from are
 * client-influenced and may run to kilobytes, so without this `maxKeys` would
 * bound how many buckets exist without bounding what they cost. Long enough
 * that no real address is truncated; a collision only merges buckets, which
 * errs toward refusing.
 */
export const MAX_RATE_LIMIT_KEY_LENGTH = 100;

export interface RateLimitOptions {
  /** Requests per window per client; defaults to `DEFAULT_RATE_LIMIT_MAX`. */
  max?: number;
  /** Window length in ms; defaults to `DEFAULT_RATE_LIMIT_WINDOW_MS`. */
  windowMs?: number;
  /**
   * Distinct keys held at once; defaults to `DEFAULT_RATE_LIMIT_MAX_KEYS`.
   * Lowered in tests so the cap is reachable without ten thousand requests.
   */
  maxKeys?: number;
  /**
   * Clock, so a test can step across a window boundary instead of waiting for
   * one. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Bucket key for a request; defaults to `clientKey`. An override is for
   * tests and for a future per-user budget, not for widening what is trusted.
   */
  keyFor?: (req: Request) => string;
}

/**
 * The client a request is counted against. Vercel sets
 * `x-vercel-forwarded-for` at the edge from the socket it accepted, and a
 * client cannot spoof it — unlike `X-Forwarded-For`, which arrives verbatim and
 * is what `req.ip` returns under `trust proxy: 1`, non-IP garbage included. So
 * the edge header wins where it exists, and `req.ip` is the fallback for local
 * dev, where nothing sits in front of this process. Neither available (no
 * readable remote address) means one shared bucket, which is stricter than
 * exempting those requests.
 */
export function clientKey(req: Request): string {
  const edge = req.headers["x-vercel-forwarded-for"];
  // Repeated headers arrive as an array, and a single one can still be a
  // comma-separated list; either way the first element is the edge's own.
  const first = (Array.isArray(edge) ? edge[0] : edge)?.split(",")[0]?.trim();

  return (first || req.ip || "unknown").slice(0, MAX_RATE_LIMIT_KEY_LENGTH);
}

interface Window {
  count: number;
  /** Timestamp at which this window stops counting and can be pruned. */
  expiresAt: number;
}

/**
 * Tells the client when its budget returns. Rounded up and never below a
 * second, so a sub-second remainder is not advertised as "retry now".
 */
function setRetryAfter(res: Response, remainingMs: number): void {
  res.setHeader(
    "Retry-After",
    String(Math.max(1, Math.ceil(remainingMs / 1000))),
  );
}

/**
 * Builds a limiter. Each call gets its own counters, so two mounts never share
 * a budget.
 */
export function createRateLimit(
  options: RateLimitOptions = {},
): RequestHandler {
  const max = options.max ?? DEFAULT_RATE_LIMIT_MAX;
  const windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const maxKeys = options.maxKeys ?? DEFAULT_RATE_LIMIT_MAX_KEYS;
  const now = options.now ?? Date.now;
  const keyFor = options.keyFor ?? clientKey;

  const windows = new Map<string, Window>();

  return (req, res, next) => {
    const at = now();

    // Pruned here rather than on a timer: an interval would hold the event loop
    // open, and a frozen Function instance would not run it anyway.
    for (const [key, window] of windows) {
      if (window.expiresAt <= at) {
        windows.delete(key);
      }
    }

    const key = keyFor(req);

    const window = windows.get(key);
    if (window === undefined) {
      // A flood of distinct keys (spoofed `X-Forwarded-For` in local dev, say)
      // would otherwise grow the map without bound and lengthen the prune scan
      // above with it. Once the cap is reached with nothing left to prune, a new
      // key is refused rather than tracked: for an abuse-mitigation middleware,
      // over-refusing under a flood is the safe direction, and the keys already
      // held — real clients inside their window — keep working.
      if (windows.size >= maxKeys) {
        // No window of this client's own to read an expiry from, so the whole
        // window length is the honest upper bound on the wait.
        setRetryAfter(res, windowMs);
        next(new AppError(429, "Too Many Requests"));
        return;
      }

      windows.set(key, { count: 1, expiresAt: at + windowMs });
      next();
      return;
    }

    window.count += 1;
    if (window.count > max) {
      setRetryAfter(res, window.expiresAt - at);
      next(new AppError(429, "Too Many Requests"));
      return;
    }

    next();
  };
}
