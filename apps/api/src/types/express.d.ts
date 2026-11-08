// Types Express itself leaves open. Kept in a declaration file so the global
// augmentation is a type-only concern and never pulls runtime code into a
// module that imports it.
import type { AuthenticatedUser } from "../auth/googleVerify.js";

declare global {
  namespace Express {
    /**
     * What `req.user` is — merged into Passport's empty placeholder interface.
     * Derived from `AuthenticatedUser` rather than restating its fields, so the
     * two cannot drift. Identity only: a sign-in's OAuth tokens go straight to
     * the integration service, so no request ever carries one here.
     */
    // The empty body is the point: an interface is required for declaration
    // merging into Passport's `User`, and every field comes from the supertype.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends AuthenticatedUser {}

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
