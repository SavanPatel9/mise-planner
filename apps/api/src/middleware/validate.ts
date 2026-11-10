// The boundary where request input becomes typed data. Every route that reads a
// body, a query string, or a path parameter mounts one of these in front of its
// handler, so the interior can trust its types, no handler hand-checks a field,
// and the wire shape of "bad input" is decided in exactly one place.
import type { Request, RequestHandler } from "express";
import { z } from "zod";

import { AppError } from "../errors.js";

/** The part of the request a validator parses. */
export type ValidationSource = "body" | "query" | "params";

/**
 * Field key for an issue that belongs to no field: a body that is not an object
 * at all, or a check attached to the whole schema rather than one of its keys.
 * Underscored so it cannot be confused with a payload field.
 */
export const ROOT_FIELD_KEY = "_root";

/** The one message a failed validation answers with. */
const VALIDATION_FAILED = "Validation failed";

type ZodIssue = z.ZodError["issues"][number];

/**
 * `ApiError.fields` for a failed parse: dotted path → message, so the client can
 * put each message next to the input that caused it. Paths follow zod's own
 * notation — `title`, `taskIds[0]`, `window.startAt` — and the first message
 * raised against a path wins, since a field with two failed checks reads better
 * as one reason and the earliest issue is the one the schema stated first.
 */
function fieldsFromIssues(issues: readonly ZodIssue[]): Record<string, string> {
  const fields: Record<string, string> = {};

  const add = (key: string, message: string): void => {
    fields[key] ??= message;
  };

  for (const issue of issues) {
    if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
      // Unknown keys arrive as a single issue whose path is the *parent*
      // object's, with the offending names in `keys`. Split it so each rejected
      // key gets its own entry and the client learns which one to drop.
      for (const key of issue.keys) {
        add(z.core.toDotPath([...issue.path, key]), issue.message);
      }
      continue;
    }

    // An empty path dots to "", which is no key at all.
    add(z.core.toDotPath(issue.path) || ROOT_FIELD_KEY, issue.message);
  }

  return fields;
}

/**
 * A validation middleware bundled with the accessor for what it parsed. The
 * accessor is what makes the parsed value typed at the handler without a cast
 * there: the schema's output type rides along on the middleware itself.
 */
export interface Validator<T> extends RequestHandler {
  /**
   * The parsed value for this validator's source. Throws rather than returning
   * `T | undefined`: nothing to read means the validator is not mounted on this
   * route, which is a wiring bug and must surface as a 500 instead of letting a
   * handler run on unvalidated input.
   */
  data: (req: Request) => T;
}

/**
 * Builds the middleware that parses `req[source]` with `schema` — and, on the
 * same object, the typed reader for the result. Mount it, then read through it:
 *
 * ```ts
 * const validateCreate = validate(createTaskSchema); // defaults to "body"
 * const validateId = validate(taskIdParamsSchema, "params");
 *
 * router.post("/", validateCreate, (req, res) => {
 *   const input = validateCreate.data(req); // typed from the schema
 *   ...
 * });
 * ```
 *
 * Each call gets its own slot in `req.validated`, keyed by a symbol private to
 * the validator it returns, so `.data()` can only ever read what its own
 * middleware wrote: a route can validate its params and its body — or mount two
 * schemas against the same source — without either clobbering the other's
 * result. The parsed value is never written back to `req[source]` — Express 5
 * exposes `req.query` as a getter with no setter, so assigning there throws.
 *
 * A rejected payload becomes a 400 `AppError` carrying per-field messages;
 * anything else thrown is a bug and goes to the error handler untouched.
 * Schemas must be synchronous — `safeParse` refuses an async refinement.
 */
export function validate<S extends z.ZodType>(
  schema: S,
  source: ValidationSource = "body",
): Validator<z.output<S>> {
  // One per validator, not per source: two validators on the same source would
  // otherwise share a slot, and the second to run would hand the first's
  // `.data()` the wrong schema's output typed as its own. The description is
  // for debugging only — identity is what keys the slot.
  const slot = Symbol(`validated:${source}`);

  const middleware: RequestHandler = (req, _res, next) => {
    let result: z.ZodSafeParseResult<z.output<S>>;
    try {
      result = schema.safeParse(req[source]);
    } catch (err) {
      next(err);
      return;
    }

    if (!result.success) {
      next(
        new AppError(
          400,
          VALIDATION_FAILED,
          fieldsFromIssues(result.error.issues),
        ),
      );
      return;
    }

    req.validated = { ...req.validated, [slot]: result.data };
    next();
  };

  return Object.assign(middleware, {
    data: (req: Request): z.output<S> => {
      const validated = req.validated;
      // `in` rather than a truthiness check: a schema may legitimately parse to
      // `undefined`, and that is still a value this validator produced.
      if (validated === undefined || !(slot in validated)) {
        throw new Error(`request did not pass validate("${source}")`);
      }

      return validated[slot] as z.output<S>;
    },
  });
}
