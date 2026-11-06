import express from "express";
import type session from "express-session";
import passport from "passport";

import { configurePassport } from "./auth/passport.js";
import { createSessionMiddleware } from "./auth/session.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import { createAuthRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";

export interface CreateAppOptions {
  /** Passed through to the session middleware; see `auth/session.ts`. */
  sessionStore?: session.Store;
}

/**
 * Builds the Express app. A factory rather than a module-level singleton so
 * tests can inject a session store and avoid a database connection.
 *
 * Registration order is execution order: parsers → session → health →
 * Passport → routers → the path-less 404 → the error handler (last).
 */
export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  // Exactly one proxy hop (Vercel) in front of this process. Not `true`, which
  // would trust the whole X-Forwarded-For chain and let a client spoof its IP.
  app.set("trust proxy", 1);

  // Nothing gains from telling clients which framework and version this is.
  app.disable("x-powered-by");

  app.use(express.json());
  app.use(createSessionMiddleware({ store: options.sessionStore }));

  // Ahead of Passport's session lookup: `passport.session()` queries the
  // database in `deserializeUser`, which would 500 `/api/health` for any
  // cookie-holder during the outage it reports on. (The session middleware
  // above still does a store lookup for cookie-bearing requests, so health
  // is not fully DB-independent — only the Passport path is removed.)
  app.use("/api", healthRouter);

  // After the session: `passport.session()` reads the login state out of
  // `req.session`, so it has nothing to work with before it exists.
  configurePassport();
  app.use(passport.initialize());
  app.use(passport.session());

  // After `passport.session()`: `/api/me` and logout read the login state it
  // restores.
  app.use("/api", createAuthRouter());

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
