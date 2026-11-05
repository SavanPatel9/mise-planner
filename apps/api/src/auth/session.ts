import connectPgSimple from "connect-pg-simple";
import type { RequestHandler } from "express";
import session from "express-session";
import { Pool } from "pg";

import { requireEnv } from "../env.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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
    store: options.store ?? createPostgresStore(),
    resave: false,
    saveUninitialized: false,
    // No `proxy` option: express-session then falls back to `req.secure`, which
    // Express derives from `X-Forwarded-Proto` under the app's `trust proxy`
    // setting. Vercel terminates TLS upstream, so that header is what makes a
    // `secure` cookie reachable at all.
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: THIRTY_DAYS_MS,
      path: "/",
    },
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
