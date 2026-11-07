import connectPgSimple from "connect-pg-simple";
import type { RequestHandler, Response } from "express";
import session from "express-session";
import { Pool } from "pg";

import { requireEnv } from "../env.js";

/** Lifetime of a session that has completed sign-in. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Idle lifetime of a session that has not. Not a total lifetime: every request
 * re-applies this `maxAge`, which slides the cookie's `expires` and the store
 * row's with it, so a session being used stays alive. What it bounds is how long
 * an abandoned one lingers — long enough for a Google round trip, short enough
 * that a scripted loop through `/api/auth/google` cannot leave 30-day rows
 * behind in the store. See `preAuthSessionTtl`.
 */
export const PRE_AUTH_SESSION_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * express-session's default, named explicitly so `clearSessionCookie` and the
 * middleware cannot drift apart.
 */
export const SESSION_COOKIE_NAME = "connect.sid";

/**
 * Cookie attributes shared by the middleware and the clear. Of these, only
 * `path` (with the domain, left implicit here) decides whether a browser
 * matches the clearing `Set-Cookie` to the stored cookie — `httpOnly`,
 * `sameSite` and `secure` are inert for deletion. One source anyway, so the
 * `path` cannot drift and the two sites stay obviously consistent. Read per
 * call rather than once at module load: `NODE_ENV` decides `secure`, and the
 * session tests set it around each `createSessionMiddleware()`.
 */
function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    // No `proxy` option on the session: express-session then falls back to
    // `req.secure`, which Express derives from `X-Forwarded-Proto` under the
    // app's `trust proxy` setting. Vercel terminates TLS upstream, so that
    // header is what makes a `secure` cookie reachable at all.
    secure: process.env.NODE_ENV === "production",
    path: "/",
  } satisfies session.CookieOptions;
}

/**
 * Removes the session cookie from the client. Destroying the session row is a
 * separate step and does not touch the cookie, which would otherwise be sent
 * on every later request only to miss in the store.
 */
export function clearSessionCookie(res: Response): void {
  // `clearCookie` drops `maxAge` itself and forces a past `expires`.
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions());
}

export interface SessionMiddlewareOptions {
  /**
   * Session store to use instead of the Postgres-backed default — the only
   * override offered, so tests can run without a database. Cookie and security
   * options are deliberately not overridable.
   */
  store?: session.Store;
}

function createPostgresStore(): session.Store {
  const PgStore = connectPgSimple(session);

  const pool = new Pool({
    connectionString: requireEnv("DATABASE_URL"),
    // Each warm Vercel Function holds its own pool against Neon's pooler, so
    // keep per-instance connections minimal.
    max: 2,
  });

  // connect-pg-simple only attaches an error listener to pools it creates
  // itself, so a dropped idle connection would otherwise emit an unhandled
  // 'error' and take the process down. Message only — the error object carries
  // the connection string.
  pool.on("error", (error) => {
    console.error("[api] session store pool error:", error.message);
  });

  return new PgStore({
    pool,
    // Owned entirely by connect-pg-simple. It must never appear in
    // schema.prisma, which already has an unrelated "Session" model (Pomodoro).
    tableName: "user_sessions",
    createTableIfMissing: true,
    // The default logs whole error objects (a failed prune, say), and a pg
    // error carries the connection string. Messages only, as above.
    errorLog: (...args: unknown[]) => {
      console.error(
        "[api] session store:",
        ...args.map((arg) => (arg instanceof Error ? arg.message : arg)),
      );
    },
  });
}

/**
 * Builds the session middleware. Throws instead of starting with an insecure
 * or unusable configuration: `SESSION_SECRET` is always required, and
 * `DATABASE_URL` is required whenever the default Postgres store is built.
 */
export function createSessionMiddleware(
  options: SessionMiddlewareOptions = {},
): RequestHandler {
  const secret = requireEnv("SESSION_SECRET");

  const handleSession = session({
    secret,
    name: SESSION_COOKIE_NAME,
    store: options.store ?? createPostgresStore(),
    resave: false,
    saveUninitialized: false,
    cookie: { ...sessionCookieOptions(), maxAge: SESSION_MAX_AGE_MS },
  });

  // With a `secure` cookie, express-session drops `Set-Cookie` for a non-HTTPS
  // request without a word: login answers 200, no session is kept, and nothing
  // says why. express-session offers no hook for it, so warn here instead —
  // once, and with no request details — so that a proxy not forwarding
  // `X-Forwarded-Proto` is diagnosable.
  let warnedInsecure = false;

  return (req, res, next) => {
    if (
      !warnedInsecure &&
      !req.secure &&
      process.env.NODE_ENV === "production"
    ) {
      warnedInsecure = true;
      console.warn(
        "[api] insecure request in production — session cookie will not be set (check proxy X-Forwarded-Proto)",
      );
    }

    handleSession(req, res, next);
  };
}

/**
 * Caps the idle lifetime of a session that has not signed in. The cookie's
 * `maxAge` is also what the store writes as the row's expiry (connect-pg-simple
 * reads `cookie.expires`), so this is what keeps a scripted sign-in loop from
 * leaving 30-day rows behind. It expires nothing that is still being used:
 * assigning `maxAge` recomputes `expires` from now, so each request through here
 * pushes the deadline out another 15 minutes. Mount on `/api/auth`, after
 * Passport and above the auth router: the rows worth capping are the ones the
 * OAuth leg writes for `state` and the PKCE verifier, and `req.isAuthenticated`
 * only exists once `passport.initialize()` has run.
 *
 * Nothing has to undo it at sign-in. `req.logIn` regenerates the session, and
 * regeneration has the store `generate` a fresh one — which rebuilds
 * `req.session.cookie` from the options `createSessionMiddleware` passed, so
 * `SESSION_MAX_AGE_MS` returns by itself. The login callback in `routes/auth.ts`
 * sets it explicitly all the same, so the granted lifetime is stated where it is
 * granted rather than inherited from a mechanism two modules away.
 */
export const preAuthSessionTtl: RequestHandler = (req, _res, next) => {
  if (!req.isAuthenticated()) {
    req.session.cookie.maxAge = PRE_AUTH_SESSION_MAX_AGE_MS;
  }

  next();
};
