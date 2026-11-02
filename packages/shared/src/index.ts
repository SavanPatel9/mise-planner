/**
 * Error body returned by every API endpoint on failure.
 * `fields` carries per-field validation messages when the error is a 422.
 */
export interface ApiError {
  error: string;
  fields?: Record<string, string>;
}
