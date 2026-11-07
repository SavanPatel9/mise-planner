import express, { type Express } from "express";
import session from "express-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import {
  createSessionMiddleware,
  preAuthSessionTtl,
  PRE_AUTH_SESSION_MAX_AGE_MS,
  SESSION_MAX_AGE_MS,
} from "./session.js";

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

/**
 * The cookie's absolute expiry, in ms. express-session serializes `maxAge` as
 * `Expires`; there is no `Max-Age` attribute on the wire, so the date is what
 * can be asserted.
 */
function cookieExpiresAt(cookie: string): number {
  const expires = cookieAttributes(cookie).find((part) =>
    part.startsWith("Expires="),
  );
  expect(expires, "expected an Expires attribute").toBeDefined();

  const expiresAt = Date.parse((expires as string).slice("Expires=".length));
  expect(Number.isNaN(expiresAt)).toBe(false);

  return expiresAt;
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

    const expiresAt = cookieExpiresAt(sessionCookie(response));
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

/** Only the internals these tests read; `MemoryStore` exposes no listing API. */
interface MemoryStoreInternals {
  sessions: Record<string, string | undefined>;
}

/**
 * The expiry each stored row carries, in ms. This — `cookie.expires` — is what
 * connect-pg-simple writes to the row's `expire` column, so it is the value
 * that decides how long a pre-auth row lingers in Postgres.
 */
function storedExpiries(store: session.MemoryStore): number[] {
  const rows = (store as unknown as MemoryStoreInternals).sessions;

  return Object.values(rows).map((raw) => {
    const parsed = JSON.parse(raw ?? "{}") as { cookie?: { expires?: string } };
    const expires = parsed.cookie?.expires;
    expect(expires, "expected a stored cookie expiry").toBeDefined();

    return Date.parse(expires as string);
  });
}

/**
 * Minimal app in the production order — session, Passport's request state (a
 * stub here), then the TTL cap mounted on `/api/auth` — so the cap is covered
 * independently of `createApp`'s wiring.
 */
function buildTtlApp(
  login: { authenticated: boolean },
  store: session.MemoryStore,
): Express {
  const app = express();

  app.set("trust proxy", 1);
  app.use(createSessionMiddleware({ store }));

  app.use((req, _res, next) => {
    req.isAuthenticated = (() =>
      login.authenticated) as typeof req.isAuthenticated;
    next();
  });

  app.use("/api/auth", preAuthSessionTtl);

  // Stands in for the sign-in leg: passport-oauth2 writes `state` and the PKCE
  // verifier to the session here, which is the row worth capping.
  app.post("/api/auth/google", (req, res) => {
    (req.session as TestSession).value = "oauth-state";
    res.json({ ok: true });
  });

  app.post("/api/elsewhere", (req, res) => {
    (req.session as TestSession).value = "kept";
    res.json({ ok: true });
  });

  return app;
}

describe("preAuthSessionTtl", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("states a 15-minute pre-auth lifetime and a 30-day signed-in one", () => {
    expect(PRE_AUTH_SESSION_MAX_AGE_MS).toBe(15 * 60 * 1000);
    expect(SESSION_MAX_AGE_MS).toBe(THIRTY_DAYS_MS);
    // The cap is only a cap if it is the shorter of the two.
    expect(PRE_AUTH_SESSION_MAX_AGE_MS).toBeLessThan(SESSION_MAX_AGE_MS);
  });

  it("caps an unauthenticated session's cookie and stored row at 15 minutes", async () => {
    const store = new session.MemoryStore();
    const before = Date.now();

    const response = await request(
      buildTtlApp({ authenticated: false }, store),
    ).post("/api/auth/google");

    expect(response.status).toBe(200);

    const cookie = sessionCookie(response);
    const expiresAt = cookieExpiresAt(cookie);
    // Cookie dates have second resolution, hence the slack on both sides.
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + PRE_AUTH_SESSION_MAX_AGE_MS - 2000,
    );
    expect(expiresAt).toBeLessThanOrEqual(
      Date.now() + PRE_AUTH_SESSION_MAX_AGE_MS + 2000,
    );
    // Well short of the full lifetime: a scripted sign-in loop must not be able
    // to leave 30-day rows behind.
    expect(expiresAt).toBeLessThan(before + SESSION_MAX_AGE_MS);

    // The store row, which is the cost the cap exists to bound.
    expect(storedExpiries(store)).toHaveLength(1);
    expect(storedExpiries(store)[0]).toBeLessThanOrEqual(
      Date.now() + PRE_AUTH_SESSION_MAX_AGE_MS + 2000,
    );

    // Only the lifetime changes; the security attributes are untouched.
    const attributes = cookieAttributes(cookie);
    expect(attributes).toContain("HttpOnly");
    expect(attributes).toContain("SameSite=Lax");
    expect(attributes).toContain("Path=/");
  });

  it("leaves an authenticated session on the full 30 days", async () => {
    const store = new session.MemoryStore();
    const before = Date.now();

    const response = await request(
      buildTtlApp({ authenticated: true }, store),
    ).post("/api/auth/google");

    // A signed-in caller re-consenting must not have their session shortened
    // to 15 minutes by passing through the same mount.
    const expiresAt = cookieExpiresAt(sessionCookie(response));
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + SESSION_MAX_AGE_MS - 2000,
    );
    expect(expiresAt).toBeLessThanOrEqual(
      Date.now() + SESSION_MAX_AGE_MS + 2000,
    );
    expect(storedExpiries(store)[0]).toBeGreaterThanOrEqual(
      before + SESSION_MAX_AGE_MS - 2000,
    );
  });

  it("does not shorten sessions outside the mount it is registered on", async () => {
    const store = new session.MemoryStore();
    const before = Date.now();

    const response = await request(
      buildTtlApp({ authenticated: false }, store),
    ).post("/api/elsewhere");

    const expiresAt = cookieExpiresAt(sessionCookie(response));
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + SESSION_MAX_AGE_MS - 2000,
    );
  });
});
