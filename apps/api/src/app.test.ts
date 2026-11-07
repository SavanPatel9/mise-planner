import session from "express-session";
import passport from "passport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Prisma is mocked at the module boundary: `deserializeUser` is the only
// database call an authenticated request makes, and no test here may open a
// connection. The spy lives outside the factory (`vi.hoisted`) so the suite can
// re-arm it per test.
const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@mise/db", () => ({
  prisma: { user: { findUnique: db.findUnique, upsert: db.upsert } },
}));

import { createApp } from "./app.js";
import { configurePassport } from "./auth/passport.js";
import { SESSION_COOKIE_NAME } from "./auth/session.js";
import {
  DEFAULT_GENERAL_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_MAX,
} from "./middleware/rateLimit.js";

// Distinctive string so a leak of the request body into the response is
// unambiguous — body-parser quotes the offending fragment in its own message
// and keeps the whole raw body on `err.body`.
const BODY_SENTINEL = "malformed-body-leak-7b21";

const USER_ID = "user-cuid-app-gate";
const SESSION_USER = {
  id: USER_ID,
  email: "chef@example.com",
  name: "Mise Chef",
};

/** Set while the Google strategy double is installed; see `afterEach`. */
let stubInstalled = false;

/**
 * Replaces the Google strategy with a double that succeeds immediately, so a
 * test can get a signed-in cookie without talking to Google. Must be called
 * *after* `createApp`, which re-registers the real strategy by the same name.
 */
function useSuccessStrategy(): void {
  const strategy = {
    name: "google",
    authenticate(this: { success(user: Express.User): void }) {
      this.success(SESSION_USER);
    },
  };

  passport.use(strategy as unknown as passport.Strategy);
  stubInstalled = true;
}

function buildApp(store: session.Store = new session.MemoryStore()) {
  return createApp({ sessionStore: store });
}

/** Only the internals these tests read; `MemoryStore` exposes no listing API. */
interface MemoryStoreInternals {
  sessions: Record<string, string | undefined>;
}

function storedSids(store: session.MemoryStore): string[] {
  return Object.keys((store as unknown as MemoryStoreInternals).sessions);
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

/** The `name=value` pair of the session cookie, ready to be sent back. */
function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const cookie = setCookieHeaders(response).find((value) =>
    value.startsWith(`${SESSION_COOKIE_NAME}=`),
  );
  expect(
    cookie,
    `expected a ${SESSION_COOKIE_NAME} Set-Cookie header`,
  ).toBeDefined();

  return (cookie as string).split(";")[0] ?? "";
}

/**
 * Runs both sign-in legs with the success double and returns the cookie a
 * signed-in client is left holding. Costs two requests against the auth rate
 * limit, which is why every test builds its own app.
 */
async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const start = await request(app).get("/api/auth/google");
  expect(start.status).toBe(302);

  useSuccessStrategy();
  const callback = await request(app)
    .get("/api/auth/google/callback?code=fake-auth-code")
    .set("Cookie", sessionCookie(start));
  expect(callback.status).toBe(302);

  return sessionCookie(callback);
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

    db.findUnique.mockReset();
    db.findUnique.mockResolvedValue(SESSION_USER);
    db.upsert.mockReset();
  });

  afterEach(() => {
    // The Passport singleton is shared, so the real strategy goes back before
    // the env stubs come off — a leaked double would silently authenticate
    // another suite's requests.
    if (stubInstalled) {
      passport.unuse("google");
      configurePassport();
      stubInstalled = false;
    }

    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses an unknown GET path under /api with the 401 envelope", async () => {
    // Default-closed: `requireAuth` is the last thing mounted on `/api`, so an
    // unauthenticated caller never learns whether the path exists.
    const response = await request(buildApp()).get("/api/nope");

    expect(response.status).toBe(401);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: "Unauthorized" });
  });

  it("answers an unknown /api path with the 404 envelope once signed in", async () => {
    const app = buildApp();
    const cookie = await signIn(app);

    const response = await request(app).get("/api/nope").set("Cookie", cookie);

    // Cleared the gate and fell through to the path-less 404 — which is what
    // proves the 401 above came from the gate and not from a missing route.
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not Found" });
  });

  it("gates an unknown non-GET /api path but still 404s outside /api", async () => {
    const app = buildApp();

    const posted = await request(app).post("/api/tasks").send({ title: "x" });
    expect(posted.status).toBe(401);
    expect(posted.body).toEqual({ error: "Unauthorized" });

    // The gate is mounted on `/api` only; anything else is a plain 404.
    const deleted = await request(app).delete("/not-even-api");
    expect(deleted.status).toBe(404);
    expect(deleted.body).toEqual({ error: "Not Found" });
  });

  it("gates a known path under an unsupported method", async () => {
    const app = buildApp();

    // `/api/health` is GET-only, so a POST falls past the health router into
    // the gate rather than into the 404.
    const unauthenticated = await request(app).post("/api/health");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toEqual({ error: "Unauthorized" });

    // GET is unaffected: the health router sits above the gate.
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);

    const cookie = await signIn(app);
    const signedIn = await request(app)
      .post("/api/health")
      .set("Cookie", cookie);
    expect(signedIn.status).toBe(404);
    expect(signedIn.body).toEqual({ error: "Not Found" });
  });

  it("leaves health, sign-in and /api/me reachable without a session", async () => {
    const app = buildApp();

    // Everything mounted above the gate, deliberately: sign-in cannot require
    // being signed in, and health must answer during an outage.
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);

    const start = await request(app).get("/api/auth/google");
    expect(start.status).toBe(302);
    expect(String(start.headers.location)).toContain(
      "accounts.google.com/o/oauth2/v2/auth",
    );

    const logout = await request(app).post("/api/auth/logout");
    expect(logout.status).toBe(204);

    // `/api/me` answers its own 401 so the web app can tell "not signed in"
    // from "the gate refused you".
    const me = await request(app).get("/api/me");
    expect(me.status).toBe(401);
    expect(me.body).toEqual({ error: "Unauthorized" });
    expect(db.findUnique).not.toHaveBeenCalled();
  });

  it("does not consult the database for a gated request it refuses", async () => {
    const response = await request(buildApp()).get("/api/tasks");

    expect(response.status).toBe(401);
    // No user id to deserialize, so nothing reaches Prisma: the 401 costs no
    // query even under a flood.
    expect(db.findUnique).not.toHaveBeenCalled();
  });

  it("does not leak parser internals on a malformed JSON body", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await request(buildApp())
      .post("/api/nope")
      .set("Content-Type", "application/json")
      .send(`{"title": "${BODY_SENTINEL}`);

    // A body-parser SyntaxError declares a 400, so the status is honest about
    // whose fault it is while the message stays generic. The parser runs above
    // the gate, so a malformed body is still a 400 rather than a 401.
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Bad Request" });
    expect(response.text).not.toContain(BODY_SENTINEL);
    expect(response.text).not.toMatch(/token|position|JSON at/i);
    // A malformed request is not a server bug; nothing to log.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("trusts exactly one proxy hop", async () => {
    // `true` would trust the whole X-Forwarded-For chain and let a client
    // spoof its address — and so its rate-limit bucket.
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

  // Each `createApp` owns its limiters, so every test here builds its own app:
  // otherwise one test's requests would spend another's budget.
  describe("the auth rate limit", () => {
    it("refuses an /api/auth flood with the 429 envelope", async () => {
      const app = buildApp();

      for (let i = 0; i < DEFAULT_RATE_LIMIT_MAX; i += 1) {
        const allowed = await request(app).post("/api/auth/logout");
        expect(allowed.status).toBe(204);
      }

      const refused = await request(app).post("/api/auth/logout");

      expect(refused.status).toBe(429);
      expect(refused.headers["content-type"]).toMatch(/application\/json/);
      expect(refused.body).toEqual({ error: "Too Many Requests" });
      // Tells the client when to come back rather than leaving it to guess.
      const retryAfter = Number(refused.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(10 * 60);
    });

    it("writes no session row for a request it refuses", async () => {
      const store = new session.MemoryStore();
      const app = buildApp(store);

      // The start leg is the expensive one: each request stores fresh OAuth
      // state, which is exactly what a scripted loop would pile up.
      for (let i = 0; i < DEFAULT_RATE_LIMIT_MAX; i += 1) {
        await request(app).get("/api/auth/google").expect(302);
      }
      expect(storedSids(store)).toHaveLength(DEFAULT_RATE_LIMIT_MAX);

      const refused = await request(app).get("/api/auth/google");

      expect(refused.status).toBe(429);
      // The limiter is mounted above the session middleware, so a refusal costs
      // no store write at all.
      expect(storedSids(store)).toHaveLength(DEFAULT_RATE_LIMIT_MAX);
      expect(setCookieHeaders(refused)).toHaveLength(0);
    });

    it("refuses a request before its body is parsed", async () => {
      const app = buildApp();

      for (let i = 0; i < DEFAULT_RATE_LIMIT_MAX; i += 1) {
        await request(app).post("/api/auth/logout").expect(204);
      }

      const refused = await request(app)
        .post("/api/auth/logout")
        .set("Content-Type", "application/json")
        .send(`{"title": "${BODY_SENTINEL}`);

      // Both limiters sit above `express.json()`, so a refusal costs no parse:
      // a malformed body answers 429 rather than the parser's 400.
      expect(refused.status).toBe(429);
      expect(refused.body).toEqual({ error: "Too Many Requests" });
      expect(refused.text).not.toContain(BODY_SENTINEL);
    });

    it("holds the strict budget to /api/auth", async () => {
      const app = buildApp();

      for (let i = 0; i < DEFAULT_RATE_LIMIT_MAX + 1; i += 1) {
        await request(app).post("/api/auth/logout");
      }
      await request(app).post("/api/auth/logout").expect(429);

      // The general `/api` limiter is a separate `createRateLimit` call with its
      // own counters, so spending the sign-in budget leaves these untouched —
      // they have only spent their own, far larger one.
      const health = await request(app).get("/api/health");
      expect(health.status).toBe(200);

      const me = await request(app).get("/api/me");
      expect(me.status).toBe(401);

      const gated = await request(app).get("/api/tasks");
      expect(gated.status).toBe(401);
    });

    it("counts the forwarded client address, not the proxy's", async () => {
      const app = buildApp();

      for (let i = 0; i < DEFAULT_RATE_LIMIT_MAX; i += 1) {
        await request(app)
          .post("/api/auth/logout")
          .set("X-Forwarded-For", "203.0.113.7")
          .expect(204);
      }
      await request(app)
        .post("/api/auth/logout")
        .set("X-Forwarded-For", "203.0.113.7")
        .expect(429);

      // Behind Vercel every request arrives on the platform's socket, so a
      // socket-keyed limit would lock out every other client at once.
      const other = await request(app)
        .post("/api/auth/logout")
        .set("X-Forwarded-For", "198.51.100.42");
      expect(other.status).toBe(204);
    });

    it("keys on the edge header in preference to X-Forwarded-For", async () => {
      const app = buildApp();

      // `X-Forwarded-For` is whatever the client sent; cycling it must not buy
      // a fresh sign-in budget per request.
      for (let i = 0; i < DEFAULT_RATE_LIMIT_MAX; i += 1) {
        await request(app)
          .post("/api/auth/logout")
          .set("X-Vercel-Forwarded-For", "203.0.113.7")
          .set("X-Forwarded-For", `10.0.0.${i}`)
          .expect(204);
      }

      const refused = await request(app)
        .post("/api/auth/logout")
        .set("X-Vercel-Forwarded-For", "203.0.113.7")
        .set("X-Forwarded-For", "10.0.0.250");
      expect(refused.status).toBe(429);

      // A different real client is still its own bucket.
      const other = await request(app)
        .post("/api/auth/logout")
        .set("X-Vercel-Forwarded-For", "198.51.100.42");
      expect(other.status).toBe(204);
    });
  });

  describe("the general rate limit", () => {
    it("meters every /api path, health included", async () => {
      const app = buildApp();

      // The cost it exists for is the session store's get-and-touch, which
      // express-session pays on any path — so the budget is spent on any path.
      for (let i = 0; i < DEFAULT_GENERAL_RATE_LIMIT_MAX; i += 1) {
        const allowed = await request(app).get("/api/health");
        expect(allowed.status).toBe(200);
      }

      const refused = await request(app).get("/api/health");
      expect(refused.status).toBe(429);
      expect(refused.headers["content-type"]).toMatch(/application\/json/);
      expect(refused.body).toEqual({ error: "Too Many Requests" });

      const retryAfter = Number(refused.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(10 * 60);

      // Mounted on `/api`, so the auth subtree spends this budget as well as
      // its own — and is refused here without having touched its 20.
      const auth = await request(app).post("/api/auth/logout");
      expect(auth.status).toBe(429);

      // And still only `/api`: nothing outside it is metered.
      const outside = await request(app).get("/not-even-api");
      expect(outside.status).toBe(404);
    });
  });
});
