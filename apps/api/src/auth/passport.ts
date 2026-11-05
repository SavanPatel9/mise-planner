// Passport wiring for Google sign-in: the strategy, its credentials, and the
// session (de)serializers. The decision logic lives in `googleVerify.ts`; this
// module only supplies the real dependencies and translates results into
// Passport's callback protocol.
//
// `req.user` is typed by the Express augmentation in `src/types/express.d.ts`.
// Nothing imports that file (it is pure declaration), so every tsconfig whose
// program reaches this module has to pull it in itself — `apps/api` by its
// `include`, the Vercel entry by its `files`.
//
// Nothing here logs — not the profile, not the address, not a token.
import { prisma } from "@mise/db";
import passport from "passport";
import {
  Strategy as GoogleStrategy,
  type GoogleCallbackParameters,
  type Profile as GoogleProfile,
  type VerifyCallback,
} from "passport-google-oauth20";

import { requireEnv } from "../env.js";
import { isAllowed } from "./allowlist.js";
import {
  GOOGLE_SCOPES,
  verifyGoogleProfile,
  type UpsertUserInput,
} from "./googleVerify.js";

/**
 * Google wants these on the authorization request — `access_type=offline` plus
 * `prompt=consent` is what makes it return a refresh token. They are
 * `authenticate()` options, not strategy options: `authorizationParams` is
 * called with the options of the current authenticate call (passport-oauth2
 * `lib/strategy.js`, which falls back to the strategy only for `scope`), so
 * passing them to the constructor would be silently ignored. Exported here so
 * the sign-in route (M2-T4) uses the same values.
 */
export const GOOGLE_AUTH_PARAMS = {
  accessType: "offline",
  prompt: "consent",
} as const;

/**
 * The scopes Google actually granted, from the token response. They differ
 * from the requested set when consent is partial, so the granted string is
 * what gets recorded. Typed as always present, but a missing or blank value
 * must not overwrite the requested set with nothing — hence the fallback to
 * `undefined`, which `verifyGoogleProfile` resolves to the default.
 */
function grantedScopes(params: GoogleCallbackParameters): string | undefined {
  const scope: string | undefined = params.scope;
  if (typeof scope !== "string" || scope.trim() === "") {
    return undefined;
  }

  return scope.trim();
}

/** The identity upsert, keyed on Google's email. */
function upsertUser({ email, name }: UpsertUserInput) {
  return prisma.user.upsert({
    where: { email },
    create: { email, name },
    // A profile without the `profile` scope reads as no name at all, which is
    // not the same as "the account has no name": leave the stored one alone
    // rather than blanking it on a narrower re-consent.
    update: name === null ? {} : { name },
    // Only what a session user needs; future columns stay out of `req.user`.
    select: { id: true, email: true, name: true },
  });
}

/** Set once the session serializers are on the singleton; see `configurePassport`. */
let serializersRegistered = false;

/**
 * Registers the Google strategy and the session serializers on the shared
 * Passport singleton. Throws if the Google credentials are missing, so a
 * misconfigured deploy fails at startup rather than at the callback.
 *
 * Safe to call again (each `createApp()` does): the env is re-validated every
 * time and the strategy rebuilt from it, since `passport.use` replaces by name
 * — latching the first build would pin stale credentials. Only the serializers
 * are registered once: `serializeUser`/`deserializeUser` append, so repeat
 * calls would stack duplicates on a process-wide singleton.
 */
export function configurePassport(): void {
  const clientID = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const callbackURL = requireEnv("GOOGLE_CALLBACK_URL");

  passport.use(
    new GoogleStrategy(
      {
        clientID,
        clientSecret,
        callbackURL,
        scope: [...GOOGLE_SCOPES],
        // Unlike `GOOGLE_AUTH_PARAMS` these two *are* strategy options, and
        // both are load-bearing. Without `state`, passport-oauth2 installs its
        // `NullStore`, whose `verify` calls back `true` unconditionally — the
        // callback route would then accept any authorization code delivered to
        // it, from any origin (login CSRF, code replay). `state: true` swaps in
        // the session-backed store, binding the callback to the session that
        // started the sign-in; `pkce` additionally binds the code to a verifier
        // only that session holds, and requires `state` (passport-oauth2
        // `lib/strategy.js` throws otherwise).
        state: true,
        pkce: true,
      },
      // Five parameters, not four: passport-oauth2 branches on the verify
      // function's arity and only passes the token response `params` — which
      // carry the granted scope string — to the five-argument form. The
      // annotations are explicit because the constructor is overloaded, and TS
      // does not contextually type a callback against overloads.
      //
      // Passport ignores the promise this returns, so every rejection has to be
      // caught here or it would surface as an unhandled rejection.
      (
        accessToken: string,
        // @types says `string`, but Google omits it unless the request asked
        // for offline access — or on a repeat consent that reuses the grant.
        refreshToken: string | undefined,
        params: GoogleCallbackParameters,
        profile: GoogleProfile,
        done: VerifyCallback,
      ) => {
        void (async () => {
          try {
            const result = await verifyGoogleProfile(
              { upsertUser, isAllowed },
              {
                profile,
                accessToken,
                refreshToken,
                scopes: grantedScopes(params),
              },
            );

            if (!result.ok) {
              // A refused sign-in, not an error: the callback route redirects
              // on it (M2-T4). The reason is a fixed token, never an address.
              done(null, false, { message: result.reason });
              return;
            }

            done(null, result.user);
          } catch (error) {
            // Only genuine faults reach here (the upsert failing, say).
            done(error instanceof Error ? error : new Error("sign-in failed"));
          }
        })();
      },
    ),
  );

  if (serializersRegistered) {
    return;
  }
  serializersRegistered = true;

  // The session holds the user id and nothing else — no email, no tokens.
  passport.serializeUser<string>((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser<string>((id, done) => {
    void (async () => {
      try {
        const user = await prisma.user.findUnique({
          where: { id },
          select: { id: true, email: true, name: true },
        });

        // A session outliving its user is not a crash: `false` clears
        // `req.user` and the request continues unauthenticated.
        done(null, user ?? false);
      } catch (error) {
        done(
          error instanceof Error ? error : new Error("session lookup failed"),
        );
      }
    })();
  });
}
