import type { RequestHandler } from "express";

import { AppError } from "../errors.js";

/**
 * Path-less fallthrough for requests that matched no router. A 404 is not an
 * error in Express, so it is converted into one here and the error handler
 * stays the single place that serializes an `ApiError` body.
 *
 * Mount after every router and before the error handler.
 */
export const notFound: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, "Not Found"));
};
