import type { ApiError } from "@mise/shared";
import type { ErrorRequestHandler } from "express";
import { STATUS_CODES } from "node:http";

import { AppError } from "../errors.js";

/**
 * Wire text for client errors raised by middleware we don't control. Their own
 * messages can quote the request body (body-parser prints the offending
 * fragment), so only these replacements are ever sent.
 */
const CLIENT_ERROR_MESSAGES: Record<number, string> = {
  400: "Bad Request",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
};

/**
 * Everything this module logs goes through here first. An error's message — and
 * so its stack, which quotes it — can carry text the caller chose:
 * passport-oauth2 builds its `AuthorizationError` out of the OAuth callback's
 * `error_description` query parameter, for one. A raw newline in that text would
 * start a fresh line in the platform's log stream, letting the caller forge log
 * entries, so control characters are escaped rather than emitted. The cost is a
 * single-line stack trace, which is the cheaper half of the trade.
 */
function logSafe(text: string): string {
  return text.replace(
    /\p{Cc}/gu,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The 4xx status a non-`AppError` declares, if any. body-parser and friends tag
 * their errors with `status`/`statusCode` plus `expose: true` (http-errors sets
 * it for every 4xx). `expose` is required so that an upstream HTTP client's
 * error — gaxios reporting a 404 from Google Calendar, say — is not mistaken
 * for a bad request from our own client; anything else is treated as a bug.
 */
function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }

  const { status, statusCode, expose } = err as {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
  };
  if (expose !== true) {
    return undefined;
  }

  const declared = typeof status === "number" ? status : statusCode;

  return typeof declared === "number" && declared >= 400 && declared <= 499
    ? declared
    : undefined;
}

/**
 * The only place an error response is serialized. Routes and services throw;
 * they never write an error body themselves.
 *
 * Must keep all four parameters — a 3-arg function is ordinary middleware and
 * never sees errors — and must be registered last.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof AppError) {
    if (err.status >= 500) {
      // An anticipated server-side failure — an upstream outage, say — is still
      // worth a log line. Message only, no stack: a thrown-through driver or
      // HTTP-client message can name hosts and credentials, so it is logged but
      // never answered with. The client gets the reason phrase instead.
      console.error("[api] app error:", logSafe(err.message));

      const body: ApiError = {
        error: STATUS_CODES[err.status] ?? "Internal Server Error",
      };
      res.status(err.status).json(body);
      return;
    }

    const body: ApiError = { error: err.message };
    if (err.fields !== undefined) {
      body.fields = err.fields;
    }

    res.status(err.status).json(body);
    return;
  }

  const clientStatus = clientErrorStatus(err);
  if (clientStatus !== undefined) {
    // The client sent something unusable: answer with the real status so it can
    // tell a bad request from an outage, but with generic text and no log —
    // this is not a bug in the API.
    const body: ApiError = {
      error:
        CLIENT_ERROR_MESSAGES[clientStatus] ??
        STATUS_CODES[clientStatus] ??
        "Bad Request",
    };

    res.status(clientStatus).json(body);
    return;
  }

  // Message and stack only. A request's body, headers, and cookies can carry
  // OAuth tokens or email content, none of which may reach the logs.
  console.error(
    "[api] unhandled error:",
    logSafe(err instanceof Error ? (err.stack ?? err.message) : String(err)),
  );

  const body: ApiError = { error: "Internal Server Error" };
  res.status(500).json(body);
};
