// Types Express itself leaves open. Kept in a declaration file so the global
// augmentation is a type-only concern and never pulls runtime code into a
// module that imports it.
import type { AuthenticatedUser } from "../auth/googleVerify.js";

declare global {
  namespace Express {
    /**
     * What `req.user` is — merged into Passport's empty placeholder interface.
     * Derived from `AuthenticatedUser` rather than restating its fields, so the
     * two cannot drift.
     *
     * `google` holds live OAuth tokens and exists only on the request that
     * completed sign-in: the session stores the user id alone, so a user
     * restored by `deserializeUser` carries no tokens — hence optional here
     * and required there.
     */
    interface User extends Omit<AuthenticatedUser, "google"> {
      google?: AuthenticatedUser["google"];
    }

    /**
     * Where `requireAuth` leaves the session's user id. Optional because the
     * augmentation is global — every request carries the property, only a gated
     * one has it set — so handlers read it through `userIdOf`, which drops the
     * `undefined` rather than passing it to a query.
     */
    interface Request {
      auth?: { userId: string };
    }
  }
}
