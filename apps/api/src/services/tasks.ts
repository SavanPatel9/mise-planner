// Task persistence — the only module that reads or writes a `Task` row. Every
// statement here carries `userId` in its `where`, including the ones already
// keyed by `id`: a task is addressed by the pair, never by the id alone, which
// is what makes a foreign row indistinguishable from a missing one (404, never
// 403, and never the row).
//
// Nothing leaves this module as a Prisma row: `toTaskDto` maps the one `select`
// below onto the shared `Task` DTO, so a column added to the schema does not
// silently join the wire shape.
import { prisma } from "@mise/db";
import type {
  CreateTaskInput,
  Task,
  TaskSource,
  TaskStatus,
  UpdateTaskInput,
} from "@mise/shared";

import { AppError } from "../errors.js";

/**
 * The source an API create records. Set explicitly because the Prisma column
 * defaults to `DUMP` — the brain-dump parser is the high-volume writer — so a
 * manual create that leaned on the default would be mislabelled. The literal is
 * checked against the shared union rather than the generated Prisma enum, which
 * keeps this module free of a runtime value from `@mise/db`.
 */
const MANUAL = "MANUAL" satisfies TaskSource;

/**
 * The columns every statement selects: exactly the fields of the shared `Task`
 * DTO, no more. `satisfies Record<keyof Task, true>` is the guard — a field
 * added to the DTO fails to compile here until it is selected, and a key that
 * is not a DTO field is rejected as an excess property.
 */
const TASK_SELECT = {
  id: true,
  title: true,
  project: true,
  estimateMin: true,
  priority: true,
  dueAt: true,
  status: true,
  source: true,
  deferCount: true,
  createdAt: true,
  updatedAt: true,
} satisfies Record<keyof Task, true>;

type TaskSelect = typeof TASK_SELECT;

/**
 * A row as `TASK_SELECT` returns it — the DTO with its three timestamps still
 * `Date`s. Derived from `Task` so the two cannot drift.
 */
type TaskRow = Omit<Task, "dueAt" | "createdAt" | "updatedAt"> & {
  dueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** `userId` spelled as required, so no `where` in this module can omit it. */
interface UserScope {
  userId: string;
}

/** One task, addressed by the `[id, userId]` pair rather than by id. */
interface TaskScope extends UserScope {
  id: string;
}

type SortDirection = "asc";

/**
 * The list order: priority first (1 = highest), then the nearest `dueAt` with
 * undated tasks last, then `createdAt` as the tiebreak — without it two tasks
 * of equal priority and no due date would come back in whatever order Postgres
 * chose, so the list could reshuffle between requests.
 */
const TASK_ORDER_BY: {
  priority?: SortDirection;
  dueAt?: { sort: SortDirection; nulls: "last" };
  createdAt?: SortDirection;
}[] = [
  { priority: "asc" },
  { dueAt: { sort: "asc", nulls: "last" } },
  { createdAt: "asc" },
];

interface FindManyArgs {
  where: UserScope & { status?: TaskStatus };
  orderBy: typeof TASK_ORDER_BY;
  select: TaskSelect;
}

interface CreateArgs {
  data: UserScope & {
    title: string;
    project?: string | undefined;
    estimateMin?: number | undefined;
    priority?: number | undefined;
    dueAt?: Date | undefined;
    source: typeof MANUAL;
  };
  select: TaskSelect;
}

/**
 * An update's `data`, built by `toUpdateData`: a key is present only when the
 * request named the field, and `null` on one of the three nullable columns is
 * the request asking to clear it.
 */
interface TaskUpdateData {
  title?: string;
  project?: string | null;
  estimateMin?: number | null;
  priority?: number;
  dueAt?: Date | null;
  status?: TaskStatus;
}

interface UpdateManyArgs {
  where: TaskScope;
  data: TaskUpdateData;
}

interface FindFirstArgs {
  where: TaskScope;
  select: TaskSelect;
}

interface DeleteManyArgs {
  where: TaskScope;
}

/**
 * The statements `updateTask` issues *inside* its transaction. Narrowed to
 * those two so the transaction callback cannot reach for a client that is not
 * the transactional one.
 */
export interface TaskTransactionClient {
  task: {
    updateMany: (args: UpdateManyArgs) => Promise<{ count: number }>;
    findFirst: (args: FindFirstArgs) => Promise<TaskRow | null>;
  };
}

/**
 * The slice of the Prisma client used here, narrowed to the statements this
 * module issues so a test can pass a double instead of a database. The shared
 * singleton is the default argument; nothing here constructs a client.
 */
export interface TaskClient {
  task: TaskTransactionClient["task"] & {
    findMany: (args: FindManyArgs) => Promise<TaskRow[]>;
    create: (args: CreateArgs) => Promise<TaskRow>;
    deleteMany: (args: DeleteManyArgs) => Promise<{ count: number }>;
  };
  $transaction: <T>(
    run: (tx: TaskTransactionClient) => Promise<T>,
  ) => Promise<T>;
}

export interface ListTasksFilter {
  status?: TaskStatus | undefined;
}

/**
 * What an id that matched no row of this user's gets. Worded exactly like the
 * path-less 404 (`middleware/notFound.ts`), so a task belonging to someone else
 * reads the same as one that never existed — the response is no existence
 * oracle.
 */
function taskNotFound(): AppError {
  return new AppError(404, "Not Found");
}

/** Field by field, never a spread: the DTO is the contract, not the row. */
function toTaskDto(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    project: row.project,
    estimateMin: row.estimateMin,
    priority: row.priority,
    dueAt: row.dueAt === null ? null : row.dueAt.toISOString(),
    status: row.status,
    source: row.source,
    deferCount: row.deferCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * ISO string → `Date`. Safe without a validity check: the only callers are
 * below, and both take a value `dueAtSchema` has already parsed.
 */
function toDueAt(dueAt: string): Date {
  return new Date(dueAt);
}

/**
 * Translates a validated patch into Prisma's `data`. An absent key is left out
 * entirely — Prisma leaves the column alone — while an explicit `null` is
 * passed through, which is how `project`, `estimateMin` and `dueAt` get
 * cleared. `=== undefined` is the test for absence rather than `in`, because
 * JSON cannot carry an explicit `undefined` in the first place.
 */
function toUpdateData(input: UpdateTaskInput): TaskUpdateData {
  const data: TaskUpdateData = {};

  if (input.title !== undefined) {
    data.title = input.title;
  }
  if (input.project !== undefined) {
    data.project = input.project;
  }
  if (input.estimateMin !== undefined) {
    data.estimateMin = input.estimateMin;
  }
  if (input.priority !== undefined) {
    data.priority = input.priority;
  }
  if (input.status !== undefined) {
    data.status = input.status;
  }
  if (input.dueAt !== undefined) {
    data.dueAt = input.dueAt === null ? null : toDueAt(input.dueAt);
  }

  return data;
}

/** This user's tasks, optionally narrowed to one status. */
export async function listTasks(
  userId: string,
  filter: ListTasksFilter,
  client: TaskClient = prisma,
): Promise<Task[]> {
  const rows = await client.task.findMany({
    where: {
      userId,
      // Omitted rather than passed as `undefined`, so an absent filter is
      // visibly "no condition" in the statement this builds.
      ...(filter.status === undefined ? {} : { status: filter.status }),
    },
    orderBy: TASK_ORDER_BY,
    select: TASK_SELECT,
  });

  return rows.map(toTaskDto);
}

/**
 * Creates a task for this user. `status` is left to the column default, which
 * is `TODO` for every writer; `source` is not — see `MANUAL` above.
 */
export async function createTask(
  userId: string,
  input: CreateTaskInput,
  client: TaskClient = prisma,
): Promise<Task> {
  const row = await client.task.create({
    data: {
      userId,
      title: input.title,
      // `undefined` is Prisma's "not provided", so an omitted optional field
      // takes the column default (`priority` 2, the rest null).
      project: input.project,
      estimateMin: input.estimateMin,
      priority: input.priority,
      dueAt: input.dueAt === undefined ? undefined : toDueAt(input.dueAt),
      source: MANUAL,
    },
    select: TASK_SELECT,
  });

  return toTaskDto(row);
}

/**
 * Applies a partial update and returns the stored task. Throws a 404 when the
 * pair matches nothing.
 *
 * `updateMany` rather than `update`, because `update` takes a unique `where`
 * and `id` alone is the only unique this model has — scoping it would mean
 * reading the row first and comparing `userId` in application code, which is a
 * check that can be forgotten. The cost is that `updateMany` returns a count
 * instead of the row, so the read back happens in the same transaction: no
 * window in which another writer's value is the one reported, and nothing
 * written at all when the pair matched no row.
 */
export async function updateTask(
  userId: string,
  id: string,
  input: UpdateTaskInput,
  client: TaskClient = prisma,
): Promise<Task> {
  const data = toUpdateData(input);

  return client.$transaction(async (tx) => {
    const { count } = await tx.task.updateMany({ where: { id, userId }, data });
    if (count === 0) {
      throw taskNotFound();
    }

    const row = await tx.task.findFirst({
      where: { id, userId },
      select: TASK_SELECT,
    });
    if (row === null) {
      // Unreachable while the transaction holds the row it just wrote; treated
      // as "gone" rather than asserted, so a surprise is a 404 and not a 500.
      throw taskNotFound();
    }

    return toTaskDto(row);
  });
}

/** Deletes a task. Throws a 404 when the pair matches nothing. */
export async function deleteTask(
  userId: string,
  id: string,
  client: TaskClient = prisma,
): Promise<void> {
  // `deleteMany`, not `delete`: same reason as `updateTask`'s `updateMany`, and
  // it reports a count instead of throwing Prisma's own not-found error.
  const { count } = await client.task.deleteMany({ where: { id, userId } });
  if (count === 0) {
    throw taskNotFound();
  }
}
