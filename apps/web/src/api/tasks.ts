// The task endpoints, behind the one fetch boundary: callers go through these
// functions rather than naming the paths themselves.
import type {
  CreateTaskInput,
  Task,
  TaskStatus,
  UpdateTaskInput,
} from "@mise/shared";

import { apiFetch } from "./client";

/**
 * `GET /api/tasks` — a bare array (no envelope — single user, no pagination),
 * sorted by priority, then `dueAt` (nulls last), then `createdAt`. Pass
 * `status` to let the server filter; omit it for every task.
 */
export function listTasks(status?: TaskStatus): Promise<Task[]> {
  const query =
    status === undefined
      ? ""
      : `?${new URLSearchParams({ status }).toString()}`;
  return apiFetch<Task[]>(`/tasks${query}`);
}

/**
 * `POST /api/tasks` — `201` with the created row, which is authoritative: the
 * server fills `id`, the defaults (`priority` 2, `status` `TODO`, `source`
 * `MANUAL`) and the timestamps, so an optimistic row is reconciled from the
 * response rather than re-fetched.
 *
 * Rejects with `ApiRequestError`; a refused payload is a `400` carrying
 * per-field messages in `fields`.
 */
export function createTask(input: CreateTaskInput): Promise<Task> {
  return apiFetch<Task>("/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * `PATCH /api/tasks/:id` — a partial update; `null` clears a clearable field,
 * an omitted key leaves it alone. Responds `200` with the updated row (same
 * reasoning as `createTask`: no re-fetch after a mutation). A task that is not
 * the caller's is a `404`, indistinguishable from one that never existed.
 */
export function updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
  return apiFetch<Task>(`/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/** `DELETE /api/tasks/:id` — `204`, nothing comes back. Same `404` shape as `updateTask`. */
export function deleteTask(id: string): Promise<void> {
  return apiFetch<void>(`/tasks/${id}`, { method: "DELETE" });
}
