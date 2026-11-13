import type { RequestHandler } from "express";

import { userIdOf } from "../auth/requireAuth.js";
import { rolloverIfNeeded } from "../services/rollover.js";
import { logSafe } from "./errorHandler.js";

/**
 * Carries the lazy day rollover on the first authenticated request of a new
 * local day. Mount directly below `requireAuth` in `app.ts`, above the gated
 * routers: `userIdOf` needs the session user, and the awaited rollover has to
 * finish before a handler reads `deferCount`, so this very request sees the new
 * counts rather than the previous day's.
 *
 * A rollover failure never fails the request. Rollover is bookkeeping — a task
 * list with yesterday's `deferCount` is worth far more to the caller than a
 * 500 — so the error is logged and `next()` is called all the same. The next
 * request of the day retries it, because nothing was claimed: the transaction
 * that would have advanced `lastRolloverOn` rolled back with it.
 *
 * `userIdOf` stays outside the `try`: its throw means this middleware was
 * mounted above `requireAuth`, a wiring bug that must surface as a 500, not
 * dissolve into the rollover's forgiving log line.
 */
export const rollover: RequestHandler = async (req, _res, next) => {
  const userId = userIdOf(req);

  try {
    await rolloverIfNeeded(userId, new Date());
  } catch (error) {
    // Message only, as in `errorHandler.ts`: a Prisma error can quote the
    // connection string, and no user id or request detail belongs in the log.
    console.error(
      "[api] rollover failed:",
      logSafe(error instanceof Error ? error.message : String(error)),
    );
  }

  next();
};
