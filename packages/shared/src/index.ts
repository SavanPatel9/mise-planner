// Type-only re-export on purpose: the API resolves `@mise/shared` through the
// tsconfig path to this file, with no build step, so a runtime value export
// here would have to exist in `dist/` to survive the import.
export type { AuthErrorFlag, MeResponse } from "./auth.js";

/**
 * Error body returned by every API endpoint on failure.
 * `fields` carries per-field validation messages when the error is a 422.
 */
export interface ApiError {
  error: string;
  fields?: Record<string, string>;
}
