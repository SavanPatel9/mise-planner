/**
 * Mirrors `TaskStatus` in `apps/db/prisma/schema.prisma` exactly. The web app
 * has no path to the Prisma client, so this union is hand-kept in sync with
 * the enum rather than imported — if the schema enum changes, update both.
 */
export type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE" | "DROPPED";

/**
 * Mirrors `TaskSource` in `apps/db/prisma/schema.prisma` exactly. Same
 * hand-sync caveat as `TaskStatus` above.
 */
export type TaskSource = "DUMP" | "GITHUB" | "GMAIL" | "OUTLOOK" | "MANUAL";

/**
 * 1–3, 1 = highest. Shared by the DTO and both payload shapes below; kept as
 * a plain `number` rather than a literal union so a client can't lean on
 * exhaustiveness checking for a range that validation — not the type system
 * — actually enforces.
 */
export type TaskPriority = number;

/**
 * A task as the API returns it. Dates cross the wire as ISO strings, never
 * `Date` — the DTO is JSON, not a Prisma row.
 */
export interface Task {
  id: string;
  title: string;
  project: string | null;
  estimateMin: number | null;
  priority: TaskPriority;
  dueAt: string | null;
  status: TaskStatus;
  source: TaskSource;
  deferCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Payload for `POST /api/tasks`. No `status` or `source`: both are set
 * server-side. `status` starts `TODO`; `source` must be set to `MANUAL`
 * explicitly in the service layer, because the Prisma column defaults to
 * `DUMP` (the brain-dump parser is the high-volume writer). A manual create
 * that leaned on the DB default would be mislabelled.
 */
export interface CreateTaskInput {
  title: string;
  project?: string;
  estimateMin?: number;
  priority?: TaskPriority;
  dueAt?: string;
}

/**
 * Payload for `PATCH /api/tasks/:id`. Every field optional — a partial
 * update, not a replacement. The three nullable columns (`project`,
 * `estimateMin`, `dueAt`) take `null` to clear the field; omitting a key
 * leaves it unchanged, which is why clearing needs an explicit `null` rather
 * than an absent value. `status` is included so this is also how a task
 * transitions (e.g. to `DONE`).
 */
export interface UpdateTaskInput {
  title?: string;
  project?: string | null;
  estimateMin?: number | null;
  priority?: TaskPriority;
  dueAt?: string | null;
  status?: TaskStatus;
}
