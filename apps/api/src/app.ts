import express from "express";
import type session from "express-session";
import passport from "passport";

import { configurePassport } from "./auth/passport.js";
import { requireAuth } from "./auth/requireAuth.js";
import { createSessionMiddleware, preAuthSessionTtl } from "./auth/session.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import {
  createRateLimit,
  DEFAULT_GENERAL_RATE_LIMIT_MAX,
} from "./middleware/rateLimit.js";
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
 * Registration order is execution order: the rate limits → parsers → session →
 * health → Passport → the pre-auth TTL → the auth router → `requireAuth` →
 * gated routers → the path-less 404 → the error handler (last).
 */
export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  // Exactly one proxy hop (Vercel) in front of this process. Not `true`, which
  // would trust the whole X-Forwarded-For chain and let a client spoof its IP.
  app.set("trust proxy", 1);

  // Nothing gains from telling clients which framework and version this is.
  app.disable("x-powered-by");

  // Both limits sit above the session middleware, so a refusal costs no store
  // round trip — and above the body parser, so it costs no parse either.
  //
  // The general one meters the store traffic every other `/api` path generates:
  // express-session does a get plus a touch (a Postgres SELECT and UPDATE) for
  // each cookie-bearing request, whatever the path, which is far more store
  // writes than sign-in ever accounts for. Its budget is generous because
  // ordinary use must never see it.
  app.use("/api", createRateLimit({ max: DEFAULT_GENERAL_RATE_LIMIT_MAX }));

  // And a strict one on the sign-in leg, where an unauthenticated caller can
  // make the store write a fresh row per request. Its own `createRateLimit`
  // call, so the two budgets are independent: `/api/auth` spends both.
  app.use("/api/auth", createRateLimit());

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

  // Caps the TTL of the session rows the sign-in leg writes. Below
  // `passport.initialize()`, which is what attaches `req.isAuthenticated`
  // (passport `lib/middleware/initialize.js`), and below `passport.session()`,
  // so an already-signed-in caller is recognized as such and keeps the full
  // lifetime. Above the auth router, which is where those rows get written.
  app.use("/api/auth", preAuthSessionTtl);

  // After `passport.session()`: `/api/me` and logout read the login state it
  // restores.
  app.use("/api", createAuthRouter());

  // The default-closed boundary: everything under `/api` registered below this
  // line requires a logged-in session and gets `req.auth.userId`. `/api/health`
  // and the auth router sit above it deliberately — sign-in cannot require
  // being signed in, and `/api/me` answers its own 401 so the web app can tell
  // "not signed in" from "gate refused you".
  app.use("/api", requireAuth);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
