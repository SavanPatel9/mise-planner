import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { z } from "zod";

import { errorHandler } from "./errorHandler.js";
import { ROOT_FIELD_KEY, validate } from "./validate.js";

/** A small, self-contained schema — not the real task schemas — so these
 * tests pin down `validate`'s own behavior rather than retesting
 * `tasks.schema.ts`. */
const bodySchema = z.strictObject({
  title: z.string().trim().min(1),
  priority: z.int().min(1).max(3).optional(),
});

/** A schema whose output differs from its raw input, so a test can tell
 * "parsed via validate.data()" apart from "read straight off req.query". */
const querySchema = z.strictObject({
  q: z.string().trim(),
});

/** A second body schema, loose where `bodySchema` is strict and with a
 * distinct output, so a route can mount both and each `.data()` has to be
 * told apart by slot rather than by source. */
const looseBodySchema = z
  .object({ title: z.string() })
  .transform((value) => ({ seen: value.title.toUpperCase() }));

function buildApp(): Express {
  const app = express();
  app.use(express.json());

  const validateBody = validate(bodySchema);
  app.post("/body", validateBody, (req, res) => {
    res.status(200).json(validateBody.data(req));
  });

  const validateQuery = validate(querySchema, "query");
  app.get("/query", validateQuery, (req, res) => {
    res.status(200).json({
      parsed: validateQuery.data(req),
      // Proves `req.query` itself was never touched by the middleware.
      raw: req.query,
    });
  });

  // Two validators on one source: each must read back its own parse, not the
  // other's, however they are ordered.
  const validateFirstBody = validate(bodySchema);
  const validateSecondBody = validate(looseBodySchema);
  app.post("/two-body", validateFirstBody, validateSecondBody, (req, res) => {
    res.status(200).json({
      first: validateFirstBody.data(req),
      second: validateSecondBody.data(req),
    });
  });

  // A handler that reads a source whose validator never ran — the wiring bug
  // `Validator.data` is documented to turn into a 500 rather than silently
  // returning `undefined`.
  const unwiredValidator = validate(bodySchema);
  app.post("/unwired", (req, res) => {
    res.status(200).json(unwiredValidator.data(req));
  });

  app.use(errorHandler);

  return app;
}

describe("validate", () => {
  it("answers invalid body with a 400 ApiError envelope naming each bad field", async () => {
    const response = await request(buildApp())
      .post("/body")
      .send({ title: "", priority: 0, extra: "nope" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation failed");
    expect(Object.keys(response.body.fields).sort()).toEqual([
      "extra",
      "priority",
      "title",
    ]);
    expect(typeof response.body.fields.title).toBe("string");
    expect(typeof response.body.fields.priority).toBe("string");
    expect(typeof response.body.fields.extra).toBe("string");
  });

  it("lets a valid body reach the handler, parsed and trimmed through .data()", async () => {
    const response = await request(buildApp())
      .post("/body")
      .send({ title: "  Trim me  ", priority: 2 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ title: "Trim me", priority: 2 });
  });

  it("rejects an unknown field with its own field name, not the parent object's", async () => {
    const response = await request(buildApp())
      .post("/body")
      .send({ title: "ok", bogus: true });

    expect(response.status).toBe(400);
    expect(Object.keys(response.body.fields)).toEqual(["bogus"]);
  });

  it("keys a non-object body under the root field, not a named field", async () => {
    // body-parser's `express.json()` runs in strict mode by default, which
    // rejects any JSON document whose top level isn't an object or array
    // before the schema ever sees it — an array clears that gate while still
    // failing `strictObject`'s own type check at the schema's root.
    const response = await request(buildApp()).post("/body").send([1, 2, 3]);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation failed");
    expect(Object.keys(response.body.fields)).toEqual([ROOT_FIELD_KEY]);
  });

  it("rejects an invalid query with a 400", async () => {
    const response = await request(buildApp()).get("/query");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation failed");
    expect(response.body.fields).toHaveProperty("q");
  });

  it("parses a valid query through .data() without mutating req.query", async () => {
    const response = await request(buildApp()).get("/query?q=%20hello%20");

    expect(response.status).toBe(200);
    expect(response.body.parsed).toEqual({ q: "hello" });
    // The raw value is untrimmed: the middleware never writes back to
    // `req.query`, which Express 5 exposes as a getter with no setter.
    expect(response.body.raw).toEqual({ q: " hello " });
  });

  it("keeps two validators on the same source from reading each other's parse", async () => {
    const response = await request(buildApp())
      .post("/two-body")
      .send({ title: "  shared body  " });

    expect(response.status).toBe(200);
    // Each `.data()` returns its own schema's output: the strict one's trimmed
    // object, the loose one's transform. A slot keyed by source alone would
    // have handed both the second parse.
    expect(response.body).toEqual({
      first: { title: "shared body" },
      second: { seen: "  SHARED BODY  " },
    });
  });

  it("500s rather than returning undefined when .data() is read for a source whose validator never ran", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await request(buildApp())
      .post("/unwired")
      .send({ title: "ok" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
    errorSpy.mockRestore();
  });
});
