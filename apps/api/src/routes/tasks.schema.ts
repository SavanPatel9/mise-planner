// Request validation for the task endpoints. `.strict()` on every object so
// an unknown field is a 400, not a silently-dropped typo; `AssertAssignable`
// below is the compile-time half of that contract — it fails the build if a
// schema's inferred output stops matching the shared payload shape.
import type {
  CreateTaskInput,
  TaskStatus,
  UpdateTaskInput,
} from "@mise/shared";
import { z } from "zod";

/** Mirrors `TaskStatus` in `@mise/shared`; kept as a literal array so `z.enum` can use it. */
const TASK_STATUS_VALUES = [
  "TODO",
  "IN_PROGRESS",
  "DONE",
  "DROPPED",
] as const satisfies readonly TaskStatus[];

/** 1 = highest, 3 = lowest — see `TaskPriority` in `@mise/shared`. */
const TASK_PRIORITY_MIN = 1;
const TASK_PRIORITY_MAX = 3;

/** Long enough for a real title, short enough to not be a pasted document. */
const TASK_TITLE_MAX_LENGTH = 500;

/** A project is a label, not prose — far shorter than a title needs to be. */
const TASK_PROJECT_MAX_LENGTH = 200;

// Both strings trim first, then require a non-empty result, so a
// whitespace-only value is rejected rather than stored as "".
const titleSchema = z.string().trim().min(1).max(TASK_TITLE_MAX_LENGTH);
const projectSchema = z.string().trim().min(1).max(TASK_PROJECT_MAX_LENGTH);
const prioritySchema = z.int().min(TASK_PRIORITY_MIN).max(TASK_PRIORITY_MAX);
// `int32`, not `int`: the column is a Postgres int4, and a plain `z.int()`
// accepts anything up to MAX_SAFE_INTEGER — which validates, overflows in the
// database, and surfaces as a 500 instead of a 400.
const estimateMinSchema = z.int32().positive();
// Default `z.iso.datetime()` options accept only the `Z` form — the same shape
// `Date#toISOString()` produces, which is how `dueAt` leaves the API on the way
// out. Bare "local" datetimes *and* numeric offsets ("+05:00") are both
// rejected; accepting the latter would need `{ offset: true }`.
const dueAtSchema = z.iso.datetime();

export const createTaskSchema = z.strictObject({
  title: titleSchema,
  project: projectSchema.optional(),
  estimateMin: estimateMinSchema.optional(),
  priority: prioritySchema.optional(),
  dueAt: dueAtSchema.optional(),
});

/** The one message an update with nothing in it answers with. */
const UPDATE_EMPTY_MESSAGE = "Provide at least one field to update";

export const updateTaskSchema = z
  .strictObject({
    title: titleSchema.optional(),
    // `.nullable()` on the three clearable fields so `null` means "clear it";
    // omitting the key leaves it unchanged (approved at the M3-T1 human gate).
    // `null` is the only way to empty one — `""` and `"   "` still fail the
    // non-empty check rather than quietly blanking a project.
    project: projectSchema.nullable().optional(),
    estimateMin: estimateMinSchema.nullable().optional(),
    priority: prioritySchema.optional(),
    dueAt: dueAtSchema.nullable().optional(),
    status: z.enum(TASK_STATUS_VALUES).optional(),
  })
  // An update naming no field is a client bug, and it cannot be served as a
  // no-op either: Postgres matches zero rows for an `updateMany` with an empty
  // `data`, which the route reads as "not yours" and answers 404 for a task
  // that does exist. Reject it at the boundary instead. `undefined` values
  // count as absent because Prisma ignores them exactly as it does a missing
  // key. The issue carries no path — the whole object is what failed — so the
  // validate middleware files it under `ROOT_FIELD_KEY`.
  .refine(
    (update) => Object.values(update).some((value) => value !== undefined),
    { message: UPDATE_EMPTY_MESSAGE },
  );

export const listTasksQuerySchema = z.strictObject({
  // Express 5 query values arrive as strings (or arrays/objects for
  // bracketed keys); a bare enum match is all `status` needs since it's
  // never numeric, so there's nothing here to coerce.
  status: z.enum(TASK_STATUS_VALUES).optional(),
});

// Deliberately not `z.cuid()`: all a route needs before it queries is that the
// value *could* be an id, so this checks charset and length only. That is
// enough to keep a path-traversal- or injection-shaped `:id` from reaching the
// database, while staying indifferent to which id format the schema generates
// (cuid today; a later migration to cuid2 or uuid must not have to touch this).
// The bound is generous for the same reason — 25 characters today.
const taskIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/i);

export const taskIdParamsSchema = z.strictObject({
  id: taskIdSchema,
});

export type CreateTaskRequest = z.infer<typeof createTaskSchema>;
export type UpdateTaskRequest = z.infer<typeof updateTaskSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type TaskIdParams = z.infer<typeof taskIdParamsSchema>;

/**
 * Compile-time-only assignability check (the `satisfies` operator needs a
 * value to attach to; this is its type-level equivalent and erases
 * completely). `T extends U` forces TypeScript to verify `T` is assignable to
 * `U` at the usage site — if the two drift apart, this file fails to compile.
 */
type AssertAssignable<T extends U, U> = T;

/*
 * Each guard below asserts four things, because no one of them is enough.
 * Assignability is one-eyed in each direction — schema → shared only catches
 * drift the *schema* cannot satisfy, shared → schema only the reverse — and
 * *neither* direction catches an extra **optional** property, since
 * assignability ignores one and only a fresh object literal gets an
 * excess-property check. Comparing `keyof` both ways closes that gap: an added
 * or removed key on either side fails to compile, optional or not.
 *
 * What this still cannot see: a value type swapped for a mutually assignable
 * one (e.g. `number` for `TaskPriority`, which is an alias of `number`) —
 * intentional, as those are one type to TypeScript. The assertions are spelled
 * out at concrete types rather than wrapped in a generic helper because a
 * generic alias checks its own constraints at the definition, not per
 * instantiation, so a wrapper would assert nothing.
 */
export type _CreateTaskDriftGuard = [
  AssertAssignable<CreateTaskRequest, CreateTaskInput>,
  AssertAssignable<CreateTaskInput, CreateTaskRequest>,
  AssertAssignable<keyof CreateTaskRequest, keyof CreateTaskInput>,
  AssertAssignable<keyof CreateTaskInput, keyof CreateTaskRequest>,
];
export type _UpdateTaskDriftGuard = [
  AssertAssignable<UpdateTaskRequest, UpdateTaskInput>,
  AssertAssignable<UpdateTaskInput, UpdateTaskRequest>,
  AssertAssignable<keyof UpdateTaskRequest, keyof UpdateTaskInput>,
  AssertAssignable<keyof UpdateTaskInput, keyof UpdateTaskRequest>,
];
