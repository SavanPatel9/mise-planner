import type { Task, UpdateTaskInput } from "@mise/shared";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

interface TaskRowProps {
  task: Task;
  /** True while a mutation for this row is in flight: every control sits still. */
  busy: boolean;
  onToggleDone: (task: Task) => void;
  onSave: (task: Task, input: UpdateTaskInput) => void;
  onDelete: (task: Task) => void;
}

/** Browser-locale rendering of `dueAt`; the wire format is ISO, not for eyes. */
const DUE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * ISO (UTC) → the local `YYYY-MM-DDTHH:mm` a `datetime-local` input takes.
 * Built by hand because `toISOString` is the wrong zone and there is no
 * native local-ISO formatter.
 */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Priority 2 is the default and goes unsaid; only the ends are worth a label. */
const PRIORITY_LABELS: Record<number, string> = {
  1: "High priority",
  3: "Low priority",
};

const FIELD_LABEL_CLASSES = "block text-xs font-medium text-slate-700";
const FIELD_INPUT_CLASSES =
  "mt-0.5 w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60";
const ACTION_BUTTON_CLASSES =
  "rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent";

/**
 * One task line: checkbox for done/not-done, the row's facts, and its own
 * edit form and delete confirmation. Editing and confirming are view state
 * only — every write goes up through the callbacks, where the optimistic
 * bookkeeping lives, and the row closes its editor the moment it hands the
 * input over (the parent rolls the row back if the call fails).
 */
export function TaskRow({
  task,
  busy,
  onToggleDone,
  onSave,
  onDelete,
}: TaskRowProps) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [estimate, setEstimate] = useState("");
  const [priority, setPriority] = useState("2");
  const [due, setDue] = useState("");
  const [dueError, setDueError] = useState<string | null>(null);
  const fieldId = useId();
  const editRef = useRef<HTMLButtonElement>(null);
  const wasBusy = useRef(false);

  /**
   * Same settle-and-refocus as the settings save button: the row's controls
   * are disabled while its mutation is in flight, which drops focus to
   * `body`, so the Edit button — the row's resting landing point — takes it
   * back once the request settles. Only from `body`/nothing, and only if the
   * row is still mounted where it was: a toggle that moved the row to another
   * group remounts it and this effect never fires, which is the conservative
   * outcome.
   */
  useEffect(() => {
    const settled = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!settled) {
      return;
    }

    const focused = document.activeElement;
    if (focused === null || focused === document.body) {
      editRef.current?.focus();
    }
  }, [busy]);

  const openEditor = () => {
    // Seeded on open, not on mount: the row the user edits is the row as it
    // stands now, including any reconciled server state.
    setTitle(task.title);
    setProject(task.project ?? "");
    setEstimate(task.estimateMin === null ? "" : String(task.estimateMin));
    setPriority(String(task.priority));
    setDue(task.dueAt === null ? "" : toLocalInputValue(task.dueAt));
    setDueError(null);
    setConfirmingDelete(false);
    setEditing(true);
  };

  const handleSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (trimmedTitle === "" || busy) {
      return;
    }

    let dueAt: string | null = null;
    if (due !== "") {
      // Guarded because `toISOString` throws on an out-of-range date, which a
      // `datetime-local` input can still hand over (or any browser falling
      // back to a plain text field).
      const parsed = new Date(due);
      if (Number.isNaN(parsed.getTime())) {
        setDueError("Enter a valid date and time.");
        return;
      }
      dueAt = parsed.toISOString();
    }

    const trimmedProject = project.trim();
    // Every editable field is sent, with `null` clearing the cleared ones —
    // a diff against the row would save a few bytes and complicate rollback.
    onSave(task, {
      title: trimmedTitle,
      project: trimmedProject === "" ? null : trimmedProject,
      estimateMin: estimate === "" ? null : Number(estimate),
      priority: Number(priority),
      dueAt,
    });
    setEditing(false);
  };

  const done = task.status === "DONE";

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <input
        type="checkbox"
        checked={done}
        onChange={() => {
          onToggleDone(task);
        }}
        disabled={busy}
        aria-label={
          done ? `Mark "${task.title}" not done` : `Mark "${task.title}" done`
        }
        className="mt-1 size-4 accent-slate-900 disabled:cursor-not-allowed"
      />

      {editing ? (
        <form onSubmit={handleSave} className="min-w-0 flex-1">
          <label htmlFor={`${fieldId}-title`} className={FIELD_LABEL_CLASSES}>
            Title
          </label>
          <input
            id={`${fieldId}-title`}
            type="text"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            required
            disabled={busy}
            className={FIELD_INPUT_CLASSES}
          />

          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div>
              <label
                htmlFor={`${fieldId}-project`}
                className={FIELD_LABEL_CLASSES}
              >
                Project
              </label>
              <input
                id={`${fieldId}-project`}
                type="text"
                value={project}
                onChange={(event) => {
                  setProject(event.target.value);
                }}
                disabled={busy}
                className={FIELD_INPUT_CLASSES}
              />
            </div>
            <div>
              <label
                htmlFor={`${fieldId}-estimate`}
                className={FIELD_LABEL_CLASSES}
              >
                Estimate (min)
              </label>
              <input
                id={`${fieldId}-estimate`}
                type="number"
                min={1}
                value={estimate}
                onChange={(event) => {
                  setEstimate(event.target.value);
                }}
                disabled={busy}
                className={FIELD_INPUT_CLASSES}
              />
            </div>
            <div>
              <label
                htmlFor={`${fieldId}-priority`}
                className={FIELD_LABEL_CLASSES}
              >
                Priority
              </label>
              <select
                id={`${fieldId}-priority`}
                value={priority}
                onChange={(event) => {
                  setPriority(event.target.value);
                }}
                disabled={busy}
                className={FIELD_INPUT_CLASSES}
              >
                <option value="1">1 — high</option>
                <option value="2">2 — normal</option>
                <option value="3">3 — low</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${fieldId}-due`} className={FIELD_LABEL_CLASSES}>
                Due
              </label>
              <input
                id={`${fieldId}-due`}
                type="datetime-local"
                value={due}
                onChange={(event) => {
                  setDue(event.target.value);
                  // The message described the value being replaced.
                  setDueError(null);
                }}
                disabled={busy}
                aria-invalid={dueError !== null}
                aria-describedby={
                  dueError !== null ? `${fieldId}-due-error` : undefined
                }
                className={FIELD_INPUT_CLASSES}
              />
              {dueError !== null ? (
                <p
                  id={`${fieldId}-due-error`}
                  role="alert"
                  className="mt-1 text-xs text-amber-800"
                >
                  {dueError}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-2 flex gap-2">
            {/* Short visible text, full accessible names: several rows can
                offer these at once, and N bare "Save"/"Cancel"/"Edit" buttons
                are indistinguishable to a screen-reader user. */}
            <button
              type="submit"
              disabled={busy}
              aria-label={`Save "${task.title}"`}
              className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-slate-900"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
              }}
              disabled={busy}
              aria-label={`Cancel editing "${task.title}"`}
              className={ACTION_BUTTON_CLASSES}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="min-w-0 flex-1">
          <p
            className={
              done
                ? "truncate text-sm text-slate-500 line-through"
                : "truncate text-sm text-slate-900"
            }
          >
            {task.title}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
            {task.project !== null ? <span>{task.project}</span> : null}
            {task.estimateMin !== null ? (
              <span>{task.estimateMin} min</span>
            ) : null}
            {task.dueAt !== null ? (
              <span>Due {DUE_FORMAT.format(new Date(task.dueAt))}</span>
            ) : null}
            {PRIORITY_LABELS[task.priority] !== undefined ? (
              <span>{PRIORITY_LABELS[task.priority]}</span>
            ) : null}
            {task.deferCount > 0 ? (
              // The rollover signal the spec cares about: how many mornings
              // this task has survived unfinished.
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900">
                deferred ×{task.deferCount}
              </span>
            ) : null}
          </p>
        </div>
      )}

      {editing ? null : (
        <div className="flex shrink-0 items-center gap-2">
          {confirmingDelete ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(false);
                  onDelete(task);
                }}
                disabled={busy}
                aria-label={`Confirm deleting "${task.title}"`}
                className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
              >
                Confirm delete
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(false);
                }}
                disabled={busy}
                aria-label={`Cancel deleting "${task.title}"`}
                className={ACTION_BUTTON_CLASSES}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                ref={editRef}
                type="button"
                onClick={openEditor}
                disabled={busy}
                aria-label={`Edit "${task.title}"`}
                className={ACTION_BUTTON_CLASSES}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(true);
                }}
                disabled={busy}
                aria-label={`Delete "${task.title}"`}
                className={ACTION_BUTTON_CLASSES}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
