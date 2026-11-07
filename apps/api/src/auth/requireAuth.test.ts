import express, { type Express, type Request } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { AppError } from "../errors.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { requireAuth, userIdOf } from "./requireAuth.js";

const USER_ID = "user-cuid-session";
/** What a client would have to be able to name for the gate to be broken. */
const FOREIGN_USER_ID = "user-cuid-someone-else";
const ACCESS_TOKEN = "fake-access-token-7e2b";

/**
 * What `passport.session()` leaves on an authenticated request, tokens
 * included: the gate may copy the id and nothing else.
 */
const SESSION_USER: Express.User = {
  id: USER_ID,
  email: "chef@example.com",
  name: "Mise Chef",
  google: {
    accessToken: ACCESS_TOKEN,
    refreshToken: "fake-refresh-token-1a44",
    scopes: "openid email",
  },
};

interface StubLogin {
  authenticated: boolean;
  /** Omitted for an unauthenticated request, as Passport leaves it. */
  user?: Express.User;
}

/**
 * Minimal app composed locally: `requireAuth` is covered here on its own, with
 * Passport's request state stubbed, because `createApp` mounts no gated router
 * yet. Mirrors the production order — gate first, then the routers below it —
 * and keeps one route *above* the gate so `userIdOf`'s failure mode is
 * observable.
 */
function buildApp(login: StubLogin): Express {
  const app = express();

  app.use(express.json());

  app.use((req, _res, next) => {
    req.isAuthenticated = (() =>
      login.authenticated) as typeof req.isAuthenticated;
    req.isUnauthenticated = (() =>
      !login.authenticated) as typeof req.isUnauthenticated;
    if (login.user !== undefined) {
      req.user = login.user;
    }

    next();
  });

  // Above the gate, so it never gets `req.auth`.
  app.get("/ungated", (req, res) => {
    res.json({ userId: userIdOf(req) });
  });

  app.use("/api", requireAuth);

  app.get("/api/echo", (req, res) => {
    res.json({ auth: req.auth ?? null, userId: userIdOf(req) });
  });

  app.post("/api/echo", (req, res) => {
    res.json({ userId: userIdOf(req) });
  });

  // The fourth channel a client controls: the path itself.
  app.get("/api/scoped/:userId", (req, res) => {
    res.json({ userId: userIdOf(req) });
  });

  app.use(errorHandler);

  return app;
}

describe("requireAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses an unauthenticated request with the 401 envelope", async () => {
    const response = await request(buildApp({ authenticated: false })).get(
      "/api/echo",
    );

    expect(response.status).toBe(401);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: "Unauthorized" });
    // The gate refused before the handler ran, so no `userId` is echoed.
    expect(response.text).not.toContain(USER_ID);
  });

  it("passes an AppError of 401 to `next` rather than answering itself", () => {
    const calls: unknown[] = [];
    const req = {
      isAuthenticated: () => false,
    } as unknown as Request;

    requireAuth(
      req,
      {} as never,
      ((error?: unknown) => {
        calls.push(error ?? null);
      }) as never,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(AppError);
    expect((calls[0] as AppError).status).toBe(401);
    expect((calls[0] as AppError).message).toBe("Unauthorized");
    // Nothing is attached on the way out: a later handler must not find a
    // half-filled `req.auth`.
    expect(req.auth).toBeUndefined();
  });

  it("attaches the session user's id, and nothing else, to an authenticated request", async () => {
    const response = await request(
      buildApp({ authenticated: true, user: SESSION_USER }),
    ).get("/api/echo");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      auth: { userId: USER_ID },
      userId: USER_ID,
    });
    // `req.auth` is built field by field from `req.user.id`, never spread, so
    // the live Google tokens on `req.user` cannot ride along.
    expect(Object.keys((response.body as { auth: object }).auth)).toEqual([
      "userId",
    ]);
    expect(response.text).not.toContain(ACCESS_TOKEN);
  });

  it.each([
    {
      channel: "a query string",
      send: (app: Express) =>
        request(app).get(`/api/echo?userId=${FOREIGN_USER_ID}`),
    },
    {
      channel: "a JSON body",
      send: (app: Express) =>
        request(app).post("/api/echo").send({ userId: FOREIGN_USER_ID }),
    },
    {
      channel: "an X-User-Id header",
      send: (app: Express) =>
        request(app).get("/api/echo").set("X-User-Id", FOREIGN_USER_ID),
    },
    {
      channel: "a path parameter",
      send: (app: Express) =>
        request(app).get(`/api/scoped/${FOREIGN_USER_ID}`),
    },
  ])("ignores a user id supplied through $channel", async ({ send }) => {
    const response = await send(
      buildApp({ authenticated: true, user: SESSION_USER }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ userId: USER_ID });
    // The whole point of the gate: nothing the client sends may decide which
    // user's rows a handler goes on to read.
    expect(response.text).not.toContain(FOREIGN_USER_ID);
  });

  it("ignores a client-supplied id on all channels at once", async () => {
    const response = await request(
      buildApp({ authenticated: true, user: SESSION_USER }),
    )
      .post(
        `/api/echo?userId=${FOREIGN_USER_ID}&auth[userId]=${FOREIGN_USER_ID}`,
      )
      .set("X-User-Id", FOREIGN_USER_ID)
      .set("Authorization", `Bearer ${FOREIGN_USER_ID}`)
      .send({ userId: FOREIGN_USER_ID, auth: { userId: FOREIGN_USER_ID } });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: USER_ID });
    expect(response.text).not.toContain(FOREIGN_USER_ID);
  });

  it("does not let an unauthenticated request smuggle in a user id", async () => {
    const response = await request(buildApp({ authenticated: false }))
      .post(`/api/echo?userId=${FOREIGN_USER_ID}`)
      .set("X-User-Id", FOREIGN_USER_ID)
      .send({ auth: { userId: FOREIGN_USER_ID } });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
  });

  it("fails closed, with no user id, when the session user carries no id", async () => {
    // Not reachable through Passport (`deserializeUser` selects `id`), so this
    // pins the failure mode rather than a supported case: a session row without
    // a usable id is refused at the gate, so no handler is ever handed
    // `{ userId: undefined }` to query with.
    const response = await request(
      buildApp({
        authenticated: true,
        user: { email: "chef@example.com" } as unknown as Express.User,
      }),
    ).get("/api/echo");

    expect(response.status).toBe(401);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: "Unauthorized" });
  });

  it.each([
    { shape: "no id at all", user: { email: "chef@example.com" } },
    { shape: "an empty id", user: { ...SESSION_USER, id: "" } },
  ])("leaves `req.auth` unset for a session user with $shape", ({ user }) => {
    const calls: unknown[] = [];
    const req = {
      isAuthenticated: () => true,
      user: user as unknown as Express.User,
    } as unknown as Request;

    requireAuth(
      req,
      {} as never,
      ((error?: unknown) => {
        calls.push(error ?? null);
      }) as never,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(AppError);
    expect((calls[0] as AppError).status).toBe(401);
    expect((calls[0] as AppError).message).toBe("Unauthorized");
    // The gate must not attach a half-filled `auth`: a `where` clause built
    // from `{ userId: undefined }` would read every user's rows.
    expect(req.auth).toBeUndefined();
  });
});

describe("userIdOf", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the id attached by the gate", () => {
    expect(userIdOf({ auth: { userId: USER_ID } } as Request)).toBe(USER_ID);
  });

  it("throws when the request never passed the gate", () => {
    expect(() => userIdOf({} as Request)).toThrow(
      "request did not pass requireAuth",
    );
  });

  it("throws rather than returning undefined for an id-less `auth`", () => {
    expect(() =>
      userIdOf({
        auth: { userId: undefined },
      } as unknown as Request),
    ).toThrow("request did not pass requireAuth");
  });

  it("surfaces a route mounted above the gate as a 500, not a 200", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await request(
      buildApp({ authenticated: true, user: SESSION_USER }),
    ).get("/ungated");

    // A wiring bug (a gated router registered too high in `app.ts`) must be
    // loud. The thrown message is internal, so the client sees the generic
    // envelope.
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
    expect(response.text).not.toContain("requireAuth");
    expect(errorSpy).toHaveBeenCalled();
  });
});
