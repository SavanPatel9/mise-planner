// The settings endpoints, behind the one fetch boundary: callers go through
// these functions rather than naming the paths themselves.
import type {
  DetectTimezoneInput,
  Settings,
  UpdateSettingsInput,
} from "@mise/shared";

import { apiFetch } from "./client";

/** `GET /api/settings` — the stored zone, and whether the user chose it. */
export function getSettings(): Promise<Settings> {
  return apiFetch<Settings>("/settings");
}

/**
 * `PATCH /api/settings`. The response is the stored settings, not a 204,
 * because the write is what decides `timezoneSource` — a client cannot send
 * that field, and any accepted write comes back `EXPLICIT`.
 *
 * Rejects with `ApiRequestError`; a zone the server cannot resolve is a `400`
 * carrying `fields.timezone`.
 */
export function updateSettings(input: UpdateSettingsInput): Promise<Settings> {
  return apiFetch<Settings>("/settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/**
 * `PATCH /api/settings/detected` — the browser's zone, offered rather than
 * chosen. The server stores it only while the stored source is still
 * `DETECTED` and leaves it `DETECTED`, so this is safe to call on every
 * sign-in and can never overwrite what the user picked in settings. A user who
 * has picked one is a 204 that changed nothing, indistinguishable from one that
 * did: nothing comes back either way.
 *
 * Rejects with `ApiRequestError`; a zone the server cannot resolve is a `400`
 * carrying `fields.timezone`.
 */
export function submitDetectedTimezone(
  input: DetectTimezoneInput,
): Promise<void> {
  return apiFetch<void>("/settings/detected", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
