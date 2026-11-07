// The four sign-in endpoints: start, callback, logout, and "who am I".
//
// Nothing here logs — not the Google profile, not the `info` a refused sign-in
// carries, not a token, not an address. The only thing a rejection puts on the
// wire is a fixed `authError` token.
import type { AuthErrorFlag, MeResponse } from "@mise/shared";
import { Router, type RequestHandler } from "express";
import passport from "passport";

import { GOOGLE_AUTH_PARAMS, VerifyFailure } from "../auth/passport.js";
import { clearSessionCookie, SESSION_MAX_AGE_MS } from "../auth/session.js";
import { requireEnv } from "../env.js";
import { AppError } from "../errors.js";

/**
 * The rejection reason, narrowed to the flags above and nothing else. Keyed on
 * `VerifyFailure` rather than on `info.message`: a provider-supplied
 * `error_description` reaches this argument as a plain `{ message }`, so reading
 * the string would let a crafted link show "not on the allowlist" for an
 * account the allowlist never saw.
 */
function authErrorFlag(info: unknown): AuthErrorFlag {
  return info instanceof VerifyFailure && info.message === "not_allowed"
    ? "not_allowed"
    : "failed";
}

/**
 * Builds the auth router. A factory, like `createApp`, so `WEB_ORIGIN` is read
 * and parsed at startup: a typo in it would otherwise surface as a broken
 * redirect at the end of a real sign-in.
 */
export function createAuthRouter(): Router {
  // Every redirect this router issues is built from this one value. Nothing
  // request-derived — no `returnTo`, no `Referer` — reaches a `Location`
  // header, which is what keeps the callback from being an open redirect.
  const webOrigin = new URL(requireEnv("WEB_ORIGIN"));
  if (webOrigin.protocol !== "https:" && webOrigin.protocol !== "http:") {
    // A non-HTTP scheme has no origin to speak of (`url.origin` is the string
    // "null"), so it would redirect nowhere useful.
    throw new Error("WEB_ORIGIN must be an http(s) URL");
  }

  function webAppUrl(authError?: AuthErrorFlag): string {
    // `.origin` on purpose: any path or query in the env value is dropped
    // rather than concatenated into something unintended.
    const url = new URL(webOrigin.origin);
    if (authError !== undefined) {
      url.searchParams.set("authError", authError);
    }

    return url.toString();
  }

  const router = Router();

  // `accessType`/`prompt` are `authenticate()` options rather than strategy
  // ones, so they have to be passed here or no refresh token comes back; see
  // `GOOGLE_AUTH_PARAMS`. The CSRF `state` and the PKCE verifier need no
  // option here — the strategy is built with `state: true`, so passport-oauth2
  // mints and stores both in the session on this leg automatically.
  const startSignIn: RequestHandler = passport.authenticate(
    "google",
    GOOGLE_AUTH_PARAMS,
  );
  router.get("/auth/google", startSignIn);

  // A custom callback rather than `successRedirect`/`failureRedirect`: the
  // redirect options drop `info`, and `info.message` is the only way to tell a
  // non-allowlisted account from any other refusal. The cost is that logging
  // the user in is now this function's job — Passport does not do it for you
  // when a callback is supplied.
  router.get("/auth/google/callback", (req, res, next) => {
    const complete: RequestHandler = passport.authenticate(
      "google",
      (
        err: unknown,
        user: Express.User | false | null | undefined,
        info: unknown,
      ) => {
        if (err) {
          next(err);
          return;
        }

        if (!user) {
          const authError = authErrorFlag(info);

          // An already-signed-in caller keeps its session. `SameSite=Lax`
          // sends the cookie on a top-level navigation, so destroying here
          // would let any page sign the user out with a link to this callback
          // carrying a forged `state` — a failed sign-in attempt must not be
          // able to undo a good one.
          if (req.isAuthenticated()) {
            res.redirect(webAppUrl(authError));
            return;
          }

          // Otherwise the refusal leaves nothing behind: an unauthenticated
          // session at this point holds only the OAuth state and verifier, so
          // it is destroyed rather than kept for a retry.
          req.session.destroy((destroyError: unknown) => {
            if (destroyError) {
              next(destroyError);
              return;
            }

            clearSessionCookie(res);
            res.redirect(webAppUrl(authError));
          });
          return;
        }

        // `logIn` regenerates the session before storing the user id, which is
        // what closes the fixation window — a session id an attacker planted
        // before sign-in is not the one that ends up authenticated. Left at the
        // default: `keepSessionInfo` would carry the pre-login session over and
        // defeat it.
        req.logIn(user, (loginError: unknown) => {
          if (loginError) {
            next(loginError);
            return;
          }

          // The regenerated session already carries this maxAge — its cookie is
          // rebuilt from the session middleware's options, discarding the
          // pre-auth cap `preAuthSessionTtl` applied — but the lifetime a
          // sign-in grants is stated here rather than left to that mechanism.
          req.session.cookie.maxAge = SESSION_MAX_AGE_MS;

          res.redirect(webAppUrl());
        });
      },
    );

    complete(req, res, next);
  });

  // POST only: a GET would let any page log the user out with an image tag.
  router.post("/auth/logout", (req, res, next) => {
    // Unauthenticated callers take the same path and also get a 204 — there is
    // no state to report on, and a 401 here would only make the web app's
    // sign-out handler branch for nothing.
    req.logout((logoutError: unknown) => {
      if (logoutError) {
        next(logoutError);
        return;
      }

      // `logout` regenerates the session, so this destroys the fresh one it
      // just created; without it the store would keep a row for a session the
      // client is about to forget.
      req.session.destroy((destroyError: unknown) => {
        if (destroyError) {
          next(destroyError);
          return;
        }

        clearSessionCookie(res);
        res.status(204).end();
      });
    });
  });

  router.get("/me", (req, res, next) => {
    if (!req.isAuthenticated()) {
      next(new AppError(401, "Unauthorized"));
      return;
    }

    // Field by field, never a spread: `req.user` can carry the live Google
    // tokens on the request that completed sign-in.
    const { id, email, name } = req.user;
    const body: MeResponse = { id, email, name };
    res.json(body);
  });

  return router;
}
