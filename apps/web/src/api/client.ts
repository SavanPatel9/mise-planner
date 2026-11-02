import type { ApiError } from "@mise/shared";

/** Thrown by `apiFetch` for any non-2xx response. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: ApiError;

  constructor(status: number, body: ApiError) {
    super(body.error);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

const FALLBACK_ERROR: ApiError = { error: "Unexpected error" };

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

async function parseErrorBody(res: Response): Promise<ApiError> {
  try {
    const parsed: unknown = await res.json();
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof (parsed as Record<string, unknown>)["error"] === "string"
    ) {
      const { error, fields } = parsed as Record<string, unknown>;
      return fields !== undefined && isStringRecord(fields)
        ? { error: error as string, fields }
        : { error: error as string };
    }
    return FALLBACK_ERROR;
  } catch {
    return FALLBACK_ERROR;
  }
}

/**
 * Fetch wrapper for same-origin `/api/...` calls. Sends cookies for
 * session auth and throws `ApiRequestError` on non-2xx responses.
 * Resolves to `undefined` for a 204 or otherwise empty response body.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers,
  });

  if (!res.ok) {
    throw new ApiRequestError(res.status, await parseErrorBody(res));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  return (text.length === 0 ? undefined : JSON.parse(text)) as T;
}
