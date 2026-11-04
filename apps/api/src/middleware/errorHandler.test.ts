import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { AppError } from "../errors.js";
import { errorHandler } from "./errorHandler.js";

// Distinctive strings so a leak into the response body is unambiguous.
const INTERNAL_SENTINEL = "pg-connection-string-leak-9f3a";
const BODY_SENTINEL = "oauth-refresh-token-leak-5c71";

function buildApp(): Express {
  const app = express();

  app.use(express.json());

  app.all("/sync", () => {
    throw new Error(`boom ${INTERNAL_SENTINEL}`);
  });

  app.all("/async", async () => {
    await Promise.resolve();
    throw new Error(`async boom ${INTERNAL_SENTINEL}`);
  });

  app.all("/non-error", () => {
    // Not every throw is an Error; the handler must still answer.
    throw `string throw ${INTERNAL_SENTINEL}`;
  });

  app.all("/validation", () => {
    throw new AppError(422, "Validation failed", {
      title: "Title is required",
    });
  });

  app.all("/forbidden", () => {
    throw new AppError(403, "Forbidden");
  });

  app.all("/upstream", () => {
    throw new AppError(503, `Calendar unavailable ${INTERNAL_SENTINEL}`);
  });

  app.all("/tagged-client-error", () => {
    // Shaped like a body-parser error: a 4xx status and `expose` on a plain
    // Error whose message quotes the request.
    throw Object.assign(new Error(`entity too large ${INTERNAL_SENTINEL}`), {
      status: 413,
      expose: true,
    });
  });

  app.all("/unmapped-client-error", () => {
    // A 4xx we keep no wire text for; the reason phrase must match the status.
    throw Object.assign(new Error(`slow down ${INTERNAL_SENTINEL}`), {
      status: 429,
      expose: true,
    });
  });

  app.all("/unexposed-client-error", () => {
    // Shaped like an upstream HTTP client's error: a 4xx status copied from
    // someone else's response, with no `expose`. That is our bug, not the
    // client's.
    throw Object.assign(new Error(`calendar said no ${INTERNAL_SENTINEL}`), {
      status: 404,
    });
  });

  app.use(errorHandler);

  return app;
}

describe("errorHandler", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collapses an unexpected synchronous throw to a generic 500", async () => {
    const response = await request(buildApp()).get("/sync");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
    expect(response.text).not.toContain(INTERNAL_SENTINEL);
    expect(response.text.toLowerCase()).not.toContain("at object");
  });

  it("collapses an unexpected async rejection to a generic 500", async () => {
    const response = await request(buildApp()).get("/async");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
    expect(response.text).not.toContain(INTERNAL_SENTINEL);
  });

  it("answers a non-Error throw with a generic 500", async () => {
    const response = await request(buildApp()).get("/non-error");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
    expect(response.text).not.toContain(INTERNAL_SENTINEL);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("logs the unexpected error server-side", async () => {
    await request(buildApp()).get("/sync");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0].map(String).join(" ");
    expect(logged).toContain(INTERNAL_SENTINEL);
  });

  it("never logs the request body or headers", async () => {
    await request(buildApp())
      .post("/sync")
      .set("Cookie", `connect.sid=${BODY_SENTINEL}`)
      .send({ token: BODY_SENTINEL });

    const logged = errorSpy.mock.calls
      .flat()
      .map((arg: unknown) => String(arg))
      .join(" ");
    expect(logged).not.toContain(BODY_SENTINEL);
  });

  it("surfaces an AppError's status, message, and fields", async () => {
    const response = await request(buildApp()).post("/validation");

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "Validation failed",
      fields: { title: "Title is required" },
    });
  });

  it("omits fields for an AppError that has none, and does not log it", async () => {
    const response = await request(buildApp()).get("/forbidden");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Forbidden" });
    expect(Object.keys(response.body)).toEqual(["error"]);
    // Operational errors are the API answering correctly, not bugs to log.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("answers an AppError of 500 or worse with the reason phrase, logging the real message", async () => {
    const response = await request(buildApp()).get("/upstream");

    // A 5xx message can come from a driver or HTTP client and name internals,
    // so it stays in the log and never reaches the client.
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "Service Unavailable" });
    expect(response.text).not.toContain(INTERNAL_SENTINEL);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0].map(String).join(" ");
    expect(logged).toContain(`Calendar unavailable ${INTERNAL_SENTINEL}`);
    expect(logged.toLowerCase()).not.toContain("at object");
  });

  it("keeps a middleware-declared 4xx status but replaces its message", async () => {
    const response = await request(buildApp()).post("/tagged-client-error");

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "Payload Too Large" });
    expect(response.text).not.toContain(INTERNAL_SENTINEL);
    // The client sent a bad request; that is not a bug to log.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("answers an unmapped 4xx with that status's own reason phrase", async () => {
    const response = await request(buildApp()).get("/unmapped-client-error");

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error: "Too Many Requests" });
    expect(response.text).not.toContain(INTERNAL_SENTINEL);
  });

  it("collapses a 4xx-tagged error that is not exposable to a 500", async () => {
    const response = await request(buildApp()).get("/unexposed-client-error");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
    expect(response.text).not.toContain(INTERNAL_SENTINEL);
    // Our bug, so it gets the full stack log.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0].map(String).join(" ");
    expect(logged).toContain(INTERNAL_SENTINEL);
  });

  it("delegates instead of writing twice once headers are sent", () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnThis();
    const res = { headersSent: true, status, json } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    const err = new AppError(422, "Validation failed");

    errorHandler(err, {} as Request, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});
