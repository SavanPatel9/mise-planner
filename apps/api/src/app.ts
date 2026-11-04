import express from "express";
import type session from "express-session";

import { createSessionMiddleware } from "./auth/session.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import { healthRouter } from "./routes/health.js";

export interface CreateAppOptions {
  /** Passed through to the session middleware; see `auth/session.ts`. */
  sessionStore?: session.Store;
}

/**
 * Builds the Express app. A factory rather than a module-level singleton so
 * tests can inject a session store and avoid a database connection.
 *
 * Registration order is execution order: parsers → session → routers → the
 * path-less 404 → the error handler (last).
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

  app.use("/api", healthRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
