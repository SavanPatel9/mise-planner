import type {
  CreateTaskInput,
  Task,
  TaskStatus,
  UpdateTaskInput,
} from "@mise/shared";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { ApiRequestError } from "../api/client";
import { createTask, deleteTask, listTasks, updateTask } from "../api/tasks";
import { TaskRow } from "../components/TaskRow";

/** The three states of `GET /api/tasks`, and nothing else. */
type LoadState =
  { status: "loading" } | { status: "failed" } | { status: "ready" };

const LOAD_FAILED = "Couldn't load your tasks. Please reload the page.";
const CREATE_FAILED = "Couldn't add the task. Please try again.";
const UPDATE_FAILED = "Couldn't save that change. Please try again.";
const DELETE_FAILED = "Couldn't delete the task. Please try again.";
const RATE_LIMITED =
  "Too many requests right now — give it a moment and try again.";
const INVALID_DUE = "Enter a valid date and time.";

/**
 * The on-screen groups, in reading order. `DROPPED` is deliberately absent:
 * dropped tasks are noise on a working screen, so they sit behind a toggle
 * below the groups instead.
 */
const GROUPS: readonly { status: TaskStatus; label: string }[] = [
  { status: "TODO", label: "To do" },
  { status: "IN_PROGRESS", label: "In progress" },
  { status: "DONE", label: "Done" },
];

/** The create form's inputs, which is also what a failed create restores. */
interface CreateFormValues {
  title: string;
  project: string;
  estimate: string;
  priority: string;
  due: string;
}

const EMPTY_CREATE_FORM: CreateFormValues = {
  title: "",
  project: "",
  estimate: "",
  priority: "",
  due: "",
};

/**
 * The server's list order, mirrored so optimistic rows land where a re-fetch
 * would put them: priority, then `dueAt` with undated tasks last, then
 * `createdAt` (ISO strings compare correctly as strings).
 */
function compareTasks(a: Task, b: Task): number {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  if (a.dueAt !== b.dueAt) {
    if (a.dueAt === null) {
      return 1;
    }
    if (b.dueAt === null) {
      return -1;
    }
    return a.dueAt < b.dueAt ? -1 : 1;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return 0;
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(compareTasks);
}

/**
 * The pre-mutation row with an update laid over it, for the optimistic
 * render. Field by field rather than a spread: the input's optional fields
 * type as possibly-`undefined`, which a spread would write into the `Task`.
 */
function applyUpdate(task: Task, input: UpdateTaskInput): Task {
  const next = { ...task };
  if (input.title !== undefined) {
    next.title = input.title;
  }
  if (input.project !== undefined) {
    next.project = input.project;
  }
  if (input.estimateMin !== undefined) {
    next.estimateMin = input.estimateMin;
  }
  if (input.priority !== undefined) {
    next.priority = input.priority;
  }
  if (input.dueAt !== undefined) {
    next.dueAt = input.dueAt;
  }
  if (input.status !== undefined) {
    next.status = input.status;
  }
  return next;
}

/**
 * A 429 gets its own line because waiting fixes it; a 400's field message is
 * shown as-is because it names what the user can correct; everything else is
 * the action-specific fallback, since the cause is not theirs to distinguish.
 */
function mutationErrorCopy(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 429) {
      return RATE_LIMITED;
    }
    const field = Object.values(error.body.fields ?? {})[0];
    if (field !== undefined) {
      return field;
    }
  }

  return fallback;
}

/**
 * Create-form field → the key the API's 400 uses for it. Identical except for
 * the two whose input names differ from the payload's.
 */
const FIELD_ERROR_KEYS: Record<keyof CreateFormValues, string> = {
  title: "title",
  project: "project",
  estimate: "estimateMin",
  priority: "priority",
  due: "dueAt",
};

/**
 * The 400 keys the create form has an error slot for. A `fields` record
 * naming none of these (the validator's root key, `priority`, a future field)
 * must fall through to the generic line instead — filing it under
 * `createFieldErrors` would make the failure invisible.
 */
const RENDERED_FIELD_KEYS = ["title", "project", "estimateMin", "dueAt"];

export function Tasks() {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [tasks, setTasks] = useState<Task[]>([]);
  // One message slot for whichever mutation failed last; each new mutation
  // clears it so the copy always describes the latest attempt.
  const [mutationError, setMutationError] = useState<string | null>(null);
  // Ids with a request in flight: their rows sit still so a second click
  // cannot race the first, and a reconcile never lands on top of a rollback.
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [showDropped, setShowDropped] = useState(false);
  const [createForm, setCreateForm] =
    useState<CreateFormValues>(EMPTY_CREATE_FORM);
  const [createFieldErrors, setCreateFieldErrors] = useState<
    Record<string, string>
  >({});
  const [creating, setCreating] = useState(false);
  const tempSeq = useRef(0);
  const formId = useId();
  const addRef = useRef<HTMLButtonElement>(null);
  const wasCreating = useRef(false);

  /**
   * Same settle-and-refocus as the settings save button: disabling the button
   * mid-flight drops focus to `body`, where nothing returns it, so the button
   * takes focus back once the request settles — only from `body`/nothing, in
   * case the user moved on while the create was in flight.
   */
  useEffect(() => {
    const settled = wasCreating.current && !creating;
    wasCreating.current = creating;
    if (!settled) {
      return;
    }

    const focused = document.activeElement;
    if (focused === null || focused === document.body) {
      addRef.current?.focus();
    }
  }, [creating]);

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const loaded = await listTasks();
        if (active) {
          setTasks(loaded);
          setLoad({ status: "ready" });
        }
      } catch {
        if (active) {
          setLoad({ status: "failed" });
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const markPending = (id: string) => {
    setPendingIds((current) => new Set(current).add(id));
  };

  const clearPending = (id: string) => {
    setPendingIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  /** Replaces the row `id` wherever the list has it now, keeping sort order. */
  const reconcile = (id: string, row: Task) => {
    setTasks((current) =>
      sortTasks(current.map((task) => (task.id === id ? row : task))),
    );
  };

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = createForm.title.trim();
    if (title === "" || creating) {
      return;
    }

    // Every submit speaks for itself: both message slots are cleared before
    // any validation can return early, or a banner from the last attempt
    // would sit beside this one's field error.
    setMutationError(null);
    setCreateFieldErrors({});

    const input: CreateTaskInput = { title };
    const project = createForm.project.trim();
    if (project !== "") {
      input.project = project;
    }
    if (createForm.estimate !== "") {
      input.estimateMin = Number(createForm.estimate);
    }
    if (createForm.priority !== "") {
      input.priority = Number(createForm.priority);
    }
    if (createForm.due !== "") {
      // Guarded because `toISOString` throws on an out-of-range date, which a
      // `datetime-local` input can still hand over (or any browser falling
      // back to a plain text field).
      const parsed = new Date(createForm.due);
      if (Number.isNaN(parsed.getTime())) {
        setCreateFieldErrors({ dueAt: INVALID_DUE });
        return;
      }
      input.dueAt = parsed.toISOString();
    }

    tempSeq.current += 1;
    const now = new Date().toISOString();
    // What the server will answer, guessed: the defaults here mirror the
    // schema's (`priority` 2, `status` TODO, `source` MANUAL), and the
    // response replaces the whole row anyway.
    const temp: Task = {
      id: `temp-${String(tempSeq.current)}`,
      title,
      project: input.project ?? null,
      estimateMin: input.estimateMin ?? null,
      priority: input.priority ?? 2,
      dueAt: input.dueAt ?? null,
      status: "TODO",
      source: "MANUAL",
      deferCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Snapshotted before the optimistic clear: a failed create hands the
    // form back exactly as submitted, so a 400 is corrected, not retyped.
    const submitted = createForm;

    setCreating(true);
    markPending(temp.id);
    setTasks((current) => sortTasks([...current, temp]));
    setCreateForm(EMPTY_CREATE_FORM);

    void createTask(input)
      .then((server) => {
        reconcile(temp.id, server);
      })
      .catch((error: unknown) => {
        setTasks((current) => current.filter((task) => task.id !== temp.id));
        setCreateForm(submitted);
        const fields =
          error instanceof ApiRequestError ? error.body.fields : undefined;
        if (
          fields !== undefined &&
          RENDERED_FIELD_KEYS.some((key) => fields[key] !== undefined)
        ) {
          setCreateFieldErrors(fields);
        } else {
          // Also the landing place for a `fields` record the form can't
          // render: `mutationErrorCopy` surfaces its first message as the
          // generic line rather than letting the failure pass silently.
          setMutationError(mutationErrorCopy(error, CREATE_FAILED));
        }
      })
      .finally(() => {
        setCreating(false);
        clearPending(temp.id);
      });
  };

  /** Shared optimistic-update path for both the checkbox and the row editor. */
  const runUpdate = (task: Task, input: UpdateTaskInput) => {
    if (pendingIds.has(task.id)) {
      return;
    }

    setMutationError(null);
    markPending(task.id);
    reconcile(task.id, applyUpdate(task, input));

    void updateTask(task.id, input)
      .then((server) => {
        reconcile(task.id, server);
      })
      .catch((error: unknown) => {
        // `task` is the row as it stood before the optimistic write: putting
        // it back is the whole rollback.
        reconcile(task.id, task);
        setMutationError(mutationErrorCopy(error, UPDATE_FAILED));
      })
      .finally(() => {
        clearPending(task.id);
      });
  };

  const handleToggleDone = (task: Task) => {
    runUpdate(task, { status: task.status === "DONE" ? "TODO" : "DONE" });
  };

  const handleDelete = (task: Task) => {
    if (pendingIds.has(task.id)) {
      return;
    }

    setMutationError(null);
    markPending(task.id);
    setTasks((current) => current.filter((t) => t.id !== task.id));

    void deleteTask(task.id)
      .catch((error: unknown) => {
        setTasks((current) => sortTasks([...current, task]));
        setMutationError(mutationErrorCopy(error, DELETE_FAILED));
      })
      .finally(() => {
        clearPending(task.id);
      });
  };

  const setField = (field: keyof CreateFormValues, value: string) => {
    setCreateForm((current) => ({ ...current, [field]: value }));
    // The message described the value the user is now replacing.
    setCreateFieldErrors((current) => {
      if (current[FIELD_ERROR_KEYS[field]] === undefined) {
        return current;
      }
      const next = { ...current };
      delete next[FIELD_ERROR_KEYS[field]];
      return next;
    });
  };

  const dropped = tasks.filter((task) => task.status === "DROPPED");

  const fieldError = (key: string) => createFieldErrors[key];

  const errorTextId = (key: string) =>
    fieldError(key) !== undefined ? `${formId}-${key}-error` : undefined;

  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="text-lg font-semibold text-slate-900">Today</h2>
      <p className="mt-1 text-sm text-slate-600">
        Everything in its place before your day begins.
      </p>

      {load.status === "loading" ? (
        <div role="status" className="mt-6 flex items-center gap-3">
          <span
            aria-hidden="true"
            // `motion-reduce:animate-none` leaves the ring itself visible, so
            // the indicator still reads as "busy" without the rotation.
            className="size-5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700 motion-reduce:animate-none"
          />
          <span className="sr-only">Loading tasks…</span>
        </div>
      ) : null}

      {load.status === "failed" ? (
        <p
          role="alert"
          className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {LOAD_FAILED}
        </p>
      ) : null}

      {load.status === "ready" ? (
        <>
          <form
            onSubmit={handleCreate}
            className="mt-6 rounded-md border border-slate-200 bg-white p-4"
          >
            <label
              htmlFor={`${formId}-title`}
              className="block text-sm font-medium text-slate-700"
            >
              New task
            </label>
            <input
              id={`${formId}-title`}
              type="text"
              value={createForm.title}
              onChange={(event) => {
                setField("title", event.target.value);
              }}
              required
              placeholder="What needs doing?"
              disabled={creating}
              aria-invalid={fieldError("title") !== undefined}
              aria-describedby={errorTextId("title")}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-amber-600"
            />
            {fieldError("title") !== undefined ? (
              <p
                id={`${formId}-title-error`}
                role="alert"
                className="mt-1 text-xs text-amber-800"
              >
                {fieldError("title")}
              </p>
            ) : null}

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <label
                  htmlFor={`${formId}-project`}
                  className="block text-xs font-medium text-slate-700"
                >
                  Project
                </label>
                <input
                  id={`${formId}-project`}
                  type="text"
                  value={createForm.project}
                  onChange={(event) => {
                    setField("project", event.target.value);
                  }}
                  disabled={creating}
                  aria-invalid={fieldError("project") !== undefined}
                  aria-describedby={errorTextId("project")}
                  className="mt-0.5 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-amber-600"
                />
                {fieldError("project") !== undefined ? (
                  <p
                    id={`${formId}-project-error`}
                    role="alert"
                    className="mt-1 text-xs text-amber-800"
                  >
                    {fieldError("project")}
                  </p>
                ) : null}
              </div>
              <div>
                <label
                  htmlFor={`${formId}-estimate`}
                  className="block text-xs font-medium text-slate-700"
                >
                  Estimate (min)
                </label>
                <input
                  id={`${formId}-estimate`}
                  type="number"
                  min={1}
                  value={createForm.estimate}
                  onChange={(event) => {
                    setField("estimate", event.target.value);
                  }}
                  disabled={creating}
                  aria-invalid={fieldError("estimateMin") !== undefined}
                  aria-describedby={errorTextId("estimateMin")}
                  className="mt-0.5 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-amber-600"
                />
                {fieldError("estimateMin") !== undefined ? (
                  <p
                    id={`${formId}-estimateMin-error`}
                    role="alert"
                    className="mt-1 text-xs text-amber-800"
                  >
                    {fieldError("estimateMin")}
                  </p>
                ) : null}
              </div>
              <div>
                <label
                  htmlFor={`${formId}-priority`}
                  className="block text-xs font-medium text-slate-700"
                >
                  Priority
                </label>
                <select
                  id={`${formId}-priority`}
                  value={createForm.priority}
                  onChange={(event) => {
                    setField("priority", event.target.value);
                  }}
                  disabled={creating}
                  className="mt-0.5 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {/* No explicit "2": the blank default already means normal,
                      and two spellings of it would be one more decision. */}
                  <option value="">Normal (default)</option>
                  <option value="1">1 — high</option>
                  <option value="3">3 — low</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor={`${formId}-due`}
                  className="block text-xs font-medium text-slate-700"
                >
                  Due
                </label>
                <input
                  id={`${formId}-due`}
                  type="datetime-local"
                  value={createForm.due}
                  onChange={(event) => {
                    setField("due", event.target.value);
                  }}
                  disabled={creating}
                  aria-invalid={fieldError("dueAt") !== undefined}
                  aria-describedby={errorTextId("dueAt")}
                  className="mt-0.5 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-amber-600"
                />
                {fieldError("dueAt") !== undefined ? (
                  <p
                    id={`${formId}-dueAt-error`}
                    role="alert"
                    className="mt-1 text-xs text-amber-800"
                  >
                    {fieldError("dueAt")}
                  </p>
                ) : null}
              </div>
            </div>

            <button
              ref={addRef}
              type="submit"
              disabled={creating}
              className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-slate-900"
            >
              {creating ? "Adding…" : "Add task"}
            </button>
          </form>

          {mutationError !== null ? (
            <p
              role="alert"
              className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
            >
              {mutationError}
            </p>
          ) : null}

          {GROUPS.map((group) => {
            const groupTasks = tasks.filter(
              (task) => task.status === group.status,
            );
            return (
              <section
                key={group.status}
                aria-labelledby={`${formId}-${group.status}`}
                className="mt-6"
              >
                <h3
                  id={`${formId}-${group.status}`}
                  className="text-sm font-semibold text-slate-900"
                >
                  {group.label}{" "}
                  <span className="font-normal text-slate-500">
                    ({groupTasks.length})
                  </span>
                </h3>
                {groupTasks.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">No tasks.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
                    {groupTasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        busy={pendingIds.has(task.id)}
                        onToggleDone={handleToggleDone}
                        onSave={runUpdate}
                        onDelete={handleDelete}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}

          {dropped.length > 0 ? (
            <section aria-labelledby={`${formId}-DROPPED`} className="mt-6">
              <h3 id={`${formId}-DROPPED`} className="text-sm">
                <button
                  type="button"
                  onClick={() => {
                    setShowDropped((current) => !current);
                  }}
                  aria-expanded={showDropped}
                  className="font-semibold text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
                >
                  {showDropped
                    ? "Hide dropped"
                    : `Show dropped (${String(dropped.length)})`}
                </button>
              </h3>
              {showDropped ? (
                <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200 bg-white opacity-70">
                  {dropped.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      busy={pendingIds.has(task.id)}
                      onToggleDone={handleToggleDone}
                      onSave={runUpdate}
                      onDelete={handleDelete}
                    />
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
