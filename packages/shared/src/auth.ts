/**
 * Body of `GET /api/me`. The three `User` columns a session carries and nothing
 * else — no tokens, no timestamps — so widening the Prisma model does not
 * silently widen what the client is told.
 */
export interface MeResponse {
  id: string;
  email: string;
  name: string | null;
}

/**
 * Query flag the web app reads off the sign-in redirect. `not_allowed` is the
 * one rejection worth its own copy ("this account isn't on the allowlist");
 * every other cause — no address on the profile, an unverified one, a failed
 * authorization — is `failed`, because telling an unknown caller which is which
 * only helps it enumerate.
 */
export type AuthErrorFlag = "not_allowed" | "failed";
