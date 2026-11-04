/**
 * A failure the API anticipated: its status and message are safe to put on the
 * wire. Anything else reaching the error handler is a bug and collapses to a
 * generic 500, so never throw `AppError` with a message that leaks internals.
 */
export class AppError extends Error {
  readonly status: number;
  /** Per-field validation messages, surfaced as the `fields` of a 422 body. */
  readonly fields?: Record<string, string>;

  constructor(
    status: number,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.fields = fields;
  }
}
