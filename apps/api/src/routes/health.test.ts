import session from "express-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createApp } from "../app.js";

describe("GET /api/health", () => {
  beforeEach(() => {
    // The session middleware requires a signing secret at build time, Passport
    // the Google credentials, and the auth router `WEB_ORIGIN`. Placeholders;
    // nothing calls Google.
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv(
      "GOOGLE_CALLBACK_URL",
      "http://localhost:3000/api/auth/google/callback",
    );
    vi.stubEnv("WEB_ORIGIN", "http://localhost:5173");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 200 with status ok and a non-negative numeric uptime", async () => {
    // An in-memory store keeps the test off the database.
    const app = createApp({ sessionStore: new session.MemoryStore() });

    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(typeof response.body.uptime).toBe("number");
    expect(response.body.uptime).toBeGreaterThanOrEqual(0);
  });
});
