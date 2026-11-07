// The authorization gate. Mounted once in `app.ts`, below the auth router and
// above every other router, so a new router is closed unless it is deliberately
// mounted earlier.
import type { Request, RequestHandler } from "express";

import { AppError } from "../errors.js";

/**
 * Refuses a request without a logged-in session and records that session's user
 * id for the handlers below.
 *
 * The id is read from `req.user` — restored from the session row by
 * `passport.session()` — and from nowhere else. Nothing here touches
 * `req.query`, `req.body`, `req.headers` or `req.params`, which is what makes a
 * client unable to name the user it acts as.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.isAuthenticated()) {
    next(new AppError(401, "Unauthorized"));
    return;
  }

  // `req.user.id` is typed `string`, but the value comes back from the session
  // store at runtime: a malformed row must refuse the request rather than
  // attach `{ userId: undefined }`, which Prisma would read as "no filter".
  const { id } = req.user;
  if (typeof id !== "string" || id === "") {
    next(new AppError(401, "Unauthorized"));
    return;
  }

  req.auth = { userId: id };
  next();
};

/**
 * The user id of a request that passed `requireAuth`. Throws rather than
 * returning `string | undefined`: a missing `auth` means the caller is mounted
 * above the gate, and a wiring bug must surface as a 500 rather than degrade
 * into an unscoped query.
 */
export function userIdOf(req: Request): string {
  const userId = req.auth?.userId;
  if (userId === undefined) {
    throw new Error("request did not pass requireAuth");
  }

  return userId;
}
