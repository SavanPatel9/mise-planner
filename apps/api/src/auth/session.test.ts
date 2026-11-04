import express, { type Express } from "express";
import session from "express-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createSessionMiddleware } from "./session.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

type TestSession = session.Session & { value?: string };

/**
 * Minimal app composed locally so these tests cover the session middleware
 * alone, independent of `createApp`'s router wiring.
 */
function buildApp(): Express {
  const app = express();

  // One proxy hop, as in production, so `X-Forwarded-Proto` is honoured.
  app.set("trust proxy", 1);
  app.use(createSessionMiddleware({ store: new session.MemoryStore() }));

  app.post("/touch", (req, res) => {
    (req.session as TestSession).value = "kept";
    res.json({ ok: true });
  });

  app.get("/read", (req, res) => {
    res.json({ value: (req.session as TestSession).value ?? null });
  });

  app.get("/untouched", (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}

function setCookieHeaders(response: {
  headers: Record<string, unknown>;
}): string[] {
  const raw = response.headers["set-cookie"];
  if (Array.isArray(raw)) {
    return raw as string[];
  }

  return typeof raw === "string" ? [raw] : [];
}

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const cookie = setCookieHeaders(response).find((value) =>
    value.startsWith("connect.sid="),
  );
  expect(cookie, "expected a connect.sid Set-Cookie header").toBeDefined();

  return cookie as string;
}

function cookieAttributes(cookie: string): string[] {
  return cookie
    .split(";")
    .slice(1)
    .map((part) => part.trim());
}

describe("createSessionMiddleware", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sets an HttpOnly, SameSite=Lax, Path=/ cookie once the session is written", async () => {
    const response = await request(buildApp()).post("/touch");

    expect(response.status).toBe(200);

    const attributes = cookieAttributes(sessionCookie(response));
    expect(attributes).toContain("HttpOnly");
    expect(attributes).toContain("SameSite=Lax");
    expect(attributes).toContain("Path=/");
  });

  it("does not mark the cookie Secure outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const response = await request(buildApp())
      .post("/touch")
      .set("X-Forwarded-Proto", "https");

    expect(cookieAttributes(sessionCookie(response))).not.toContain("Secure");
  });

  it("expires the cookie roughly 30 days out", async () => {
    const before = Date.now();
    const response = await request(buildApp()).post("/touch");

    // express-session serializes `maxAge` as `Expires`; there is no `Max-Age`
    // attribute on the wire, so the absolute date is what we can assert.
    const expires = cookieAttributes(sessionCookie(response)).find((part) =>
      part.startsWith("Expires="),
    );
    expect(expires, "expected an Expires attribute").toBeDefined();

    const expiresAt = Date.parse((expires as string).slice("Expires=".length));
    expect(Number.isNaN(expiresAt)).toBe(false);
    // Cookie dates have second resolution, hence the slack on both sides.
    expect(expiresAt).toBeGreaterThanOrEqual(before + THIRTY_DAYS_MS - 2000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + THIRTY_DAYS_MS + 2000);
  });

  it("sends no cookie for a request that never writes to the session", async () => {
    const response = await request(buildApp()).get("/untouched");

    expect(response.status).toBe(200);
    expect(setCookieHeaders(response)).toHaveLength(0);
  });

  it("round-trips session data through the injected store", async () => {
    const agent = request.agent(buildApp());

    await agent.post("/touch").expect(200);
    const response = await agent.get("/read");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ value: "kept" });
  });

  it("marks the cookie Secure in production behind an HTTPS proxy", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // express-session warns once about MemoryStore in production.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await request(buildApp())
      .post("/touch")
      .set("X-Forwarded-Proto", "https");

    expect(response.status).toBe(200);
    expect(cookieAttributes(sessionCookie(response))).toContain("Secure");
  });

  it("refuses to set the production cookie over plain HTTP, and says so once", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = buildApp();
    const response = await request(app)
      .post("/touch")
      .set("X-Forwarded-Proto", "http");

    expect(response.status).toBe(200);
    expect(setCookieHeaders(response)).toHaveLength(0);

    // Dropping Set-Cookie is otherwise silent, so the warning is the only
    // signal that a proxy isn't forwarding X-Forwarded-Proto.
    const insecureWarnings = () =>
      warnSpy.mock.calls.filter((call) =>
        call.map(String).join(" ").includes("insecure request in production"),
      );
    expect(insecureWarnings()).toHaveLength(1);

    await request(app).post("/touch").set("X-Forwarded-Proto", "http");
    expect(insecureWarnings()).toHaveLength(1);
  });

  it("does not warn about an HTTPS request in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await request(buildApp()).post("/touch").set("X-Forwarded-Proto", "https");

    const logged = warnSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).not.toContain("insecure request in production");
  });

  it("does not warn about a plain-HTTP request outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await request(buildApp()).post("/touch");

    const logged = warnSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).not.toContain("insecure request in production");
  });

  it("throws when SESSION_SECRET is unset", () => {
    vi.stubEnv("SESSION_SECRET", undefined);

    expect(() =>
      createSessionMiddleware({ store: new session.MemoryStore() }),
    ).toThrow("Missing required env var: SESSION_SECRET");
  });

  it("throws when SESSION_SECRET is blank", () => {
    vi.stubEnv("SESSION_SECRET", "   \t ");

    expect(() =>
      createSessionMiddleware({ store: new session.MemoryStore() }),
    ).toThrow("Missing required env var: SESSION_SECRET");
  });

  it("throws before touching Postgres when the default store has no DATABASE_URL", () => {
    vi.stubEnv("DATABASE_URL", undefined);

    expect(() => createSessionMiddleware()).toThrow(
      "Missing required env var: DATABASE_URL",
    );
  });

  it("ignores a missing DATABASE_URL when a store is injected", () => {
    vi.stubEnv("DATABASE_URL", undefined);

    expect(() =>
      createSessionMiddleware({ store: new session.MemoryStore() }),
    ).not.toThrow();
  });
});
