import session from "express-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createApp } from "./app.js";

// Distinctive string so a leak of the request body into the response is
// unambiguous — body-parser quotes the offending fragment in its own message
// and keeps the whole raw body on `err.body`.
const BODY_SENTINEL = "malformed-body-leak-7b21";

function buildApp() {
  return createApp({ sessionStore: new session.MemoryStore() });
}

describe("createApp", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    // The factory also configures Passport, which requires the Google
    // credentials up front. Values are placeholders; nothing here calls Google.
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv(
      "GOOGLE_CALLBACK_URL",
      "http://localhost:3000/api/auth/google/callback",
    );
    // The auth router parses this at build time to derive its redirects.
    vi.stubEnv("WEB_ORIGIN", "http://localhost:5173");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("answers an unknown GET path with the 404 error envelope", async () => {
    const response = await request(buildApp()).get("/api/nope");

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: "Not Found" });
  });

  it("answers an unknown non-GET path with the 404 error envelope", async () => {
    const app = buildApp();

    const posted = await request(app).post("/api/tasks").send({ title: "x" });
    expect(posted.status).toBe(404);
    expect(posted.body).toEqual({ error: "Not Found" });

    const deleted = await request(app).delete("/not-even-api");
    expect(deleted.status).toBe(404);
    expect(deleted.body).toEqual({ error: "Not Found" });
  });

  it("404s a known path under an unsupported method", async () => {
    const response = await request(buildApp()).post("/api/health");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not Found" });
  });

  it("does not leak parser internals on a malformed JSON body", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await request(buildApp())
      .post("/api/nope")
      .set("Content-Type", "application/json")
      .send(`{"title": "${BODY_SENTINEL}`);

    // A body-parser SyntaxError declares a 400, so the status is honest about
    // whose fault it is while the message stays generic.
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Bad Request" });
    expect(response.text).not.toContain(BODY_SENTINEL);
    expect(response.text).not.toMatch(/token|position|JSON at/i);
    // A malformed request is not a server bug; nothing to log.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("trusts exactly one proxy hop", async () => {
    // `true` would trust the whole X-Forwarded-For chain and let a client
    // spoof its address.
    expect(buildApp().get("trust proxy")).toBe(1);
  });

  it("does not advertise the framework in its responses", async () => {
    const response = await request(buildApp()).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("fails fast when SESSION_SECRET is missing", () => {
    vi.stubEnv("SESSION_SECRET", undefined);

    expect(() => buildApp()).toThrow(
      "Missing required env var: SESSION_SECRET",
    );
  });
});
