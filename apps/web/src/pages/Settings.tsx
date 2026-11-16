import type { Settings as UserSettings } from "@mise/shared";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { ApiRequestError } from "../api/client";
import {
  getSettings,
  resumeDetection,
  submitDetectedTimezone,
  updateSettings,
} from "../api/settings";

/** The three states of `GET /api/settings`, and nothing else. */
type LoadState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; settings: UserSettings };

const LOAD_FAILED = "Couldn't load your settings. Please reload the page.";
const SAVE_FAILED = "Couldn't save your timezone. Please try again.";
const DETECT_FAILED = "Couldn't turn detection back on. Please try again.";
const DETECT_RESUMED = "Timezone detection turned back on.";

/**
 * Every zone offered by the picker. The stored one is folded in because
 * `supportedValuesOf` lists canonical names only — a stored alias
 * (`Asia/Calcutta`, `US/Pacific`) is absent from it, and a controlled `select`
 * whose value is not among its options shows nothing selected. The `typeof`
 * guard covers a runtime without the method at all, where the stored zone is
 * then the single option.
 */
function timezoneOptions(stored: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];

  return [...new Set([...supported, stored])].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * A rejected zone is the one error the user can act on, so the server's own
 * field message is shown as-is; everything else — a 500, an unreachable API —
 * is one generic line, since the cause is not theirs to distinguish.
 */
function saveErrorCopy(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const field = error.body.fields?.["timezone"];
    if (field !== undefined) {
      return field;
    }
  }

  return SAVE_FAILED;
}

export function Settings() {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  // Seeded from the stored zone once it arrives: the picker is the user's
  // working copy, which a failed save must not discard.
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedZone, setSavedZone] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detectNote, setDetectNote] = useState<string | null>(null);
  const selectId = useId();
  const errorId = useId();
  const saveRef = useRef<HTMLButtonElement>(null);
  const wasSaving = useRef(false);
  const detectRef = useRef<HTMLButtonElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const wasReverting = useRef(false);

  // One write at a time: both buttons and the picker sit still while either
  // request is in flight, so the two write paths cannot race each other from
  // this screen.
  const busy = saving || reverting;

  // Only the stored zone decides the option list, so it is rebuilt when that
  // changes and not on every keystroke of state around it: `supportedValuesOf`
  // plus the dedupe and sort is ~420 zones, and React would reconcile 420
  // fresh `option` elements each time.
  const storedZone = load.status === "ready" ? load.settings.timezone : null;
  const zones = useMemo(
    () => (storedZone === null ? [] : timezoneOptions(storedZone)),
    [storedZone],
  );

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const settings = await getSettings();
        if (active) {
          setLoad({ status: "ready", settings });
          setSelected(settings.timezone);
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

  /**
   * Disabling the button mid-flight drops focus to `body`, where nothing
   * returns it: after a refused save a keyboard user would have to tab from the
   * top of the document to reach the message. So the button takes focus back
   * once the request settles — in an effect, since a disabled button cannot be
   * focused and the re-enable has to render first. Only from `body`/nothing: if
   * the user moved on while the save was in flight, that is where they meant to
   * be.
   */
  useEffect(() => {
    const settled = wasSaving.current && !saving;
    wasSaving.current = saving;
    if (!settled) {
      return;
    }

    const focused = document.activeElement;
    if (focused === null || focused === document.body) {
      saveRef.current?.focus();
    }
  }, [saving]);

  /**
   * Same settle-and-refocus as the save button, with one extra wrinkle: a
   * successful revert unmounts the "Detect automatically" button (the source
   * is `DETECTED` now), so focus falls through to the picker instead.
   */
  useEffect(() => {
    const settled = wasReverting.current && !reverting;
    wasReverting.current = reverting;
    if (!settled) {
      return;
    }

    const focused = document.activeElement;
    if (focused === null || focused === document.body) {
      (detectRef.current ?? selectRef.current)?.focus();
    }
  }, [reverting]);

  const handleResumeDetection = () => {
    if (busy) {
      return;
    }

    setReverting(true);
    setDetectError(null);
    setDetectNote(null);
    // The save results describe writes this one supersedes.
    setSaveError(null);
    setSavedZone(null);

    void (async () => {
      try {
        // Flip the source back first, then offer the browser's zone through
        // the detection path the flip just reopened — the same conditional
        // write the sign-in hook uses, so an explicit save racing this still
        // wins. The re-read afterwards is what the screen shows: never a
        // guess at what the two writes left behind.
        let settings = await resumeDetection();
        const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (detected && detected !== settings.timezone) {
          await submitDetectedTimezone({ timezone: detected });
          settings = await getSettings();
        }

        setLoad({ status: "ready", settings });
        setSelected(settings.timezone);
        setDetectNote(DETECT_RESUMED);
      } catch {
        setDetectError(DETECT_FAILED);
      } finally {
        setReverting(false);
      }
    })();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === null || busy) {
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSavedZone(null);
    // A fresh explicit choice retires the detection messages the same way.
    setDetectError(null);
    setDetectNote(null);

    void updateSettings({ timezone: selected })
      .then((settings) => {
        setLoad({ status: "ready", settings });
        setSelected(settings.timezone);
        setSavedZone(settings.timezone);
      })
      .catch((error: unknown) => {
        // The picker keeps whatever the user left in it: a refused zone is
        // theirs to correct, and resetting it would hide what was refused.
        setSaveError(saveErrorCopy(error));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <div className="max-w-md">
      <h2 className="text-lg font-semibold text-slate-900">Settings</h2>
      <p className="mt-1 text-sm text-slate-600">
        Your timezone decides when a day rolls over into the next.
      </p>

      {load.status === "loading" ? (
        <div role="status" className="mt-6 flex items-center gap-3">
          <span
            aria-hidden="true"
            // `motion-reduce:animate-none` leaves the ring itself visible, so
            // the indicator still reads as "busy" without the rotation.
            className="size-5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700 motion-reduce:animate-none"
          />
          <span className="sr-only">Loading settings…</span>
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

      {load.status === "ready" && selected !== null ? (
        <form onSubmit={handleSubmit} className="mt-6">
          <p className="text-sm text-slate-700">
            Current timezone:{" "}
            <span className="font-medium text-slate-900">
              {load.settings.timezone}
            </span>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {load.settings.timezoneSource === "EXPLICIT"
              ? "Chosen by you — detection is off."
              : "Detected from your browser."}
          </p>

          {load.settings.timezoneSource === "EXPLICIT" ? (
            <button
              ref={detectRef}
              type="button"
              onClick={handleResumeDetection}
              disabled={busy}
              className="mt-2 rounded-md border border-slate-400 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-white"
            >
              {reverting ? "Turning on…" : "Detect automatically"}
            </button>
          ) : null}

          {detectError !== null ? (
            <p
              role="alert"
              className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
            >
              {detectError}
            </p>
          ) : null}

          <label
            htmlFor={selectId}
            className="mt-6 block text-sm font-medium text-slate-700"
          >
            Timezone
          </label>
          <select
            ref={selectRef}
            id={selectId}
            name="timezone"
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value);
              // Both results describe the selection that produced them: a
              // refusal must not mark a corrected choice invalid, and
              // "Timezone saved: X" must not sit next to a picker showing Y.
              setSaveError(null);
              setSavedZone(null);
            }}
            disabled={busy}
            aria-invalid={saveError !== null}
            aria-describedby={saveError !== null ? errorId : undefined}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-amber-600"
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>

          {/* Never disabled on an unchanged selection: saving the zone that is
              already stored is how a detected guess becomes the user's own
              choice, which is the point of the screen. */}
          <button
            ref={saveRef}
            type="submit"
            disabled={busy}
            className="mt-6 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-slate-900"
          >
            {saving ? "Saving…" : "Save timezone"}
          </button>

          {/* Rendered unconditionally so the live region exists before it has
              anything to announce. One region for both outcomes — a save and a
              resumed detection clear each other's message, so it only ever
              carries one. */}
          <div role="status">
            {savedZone !== null ? (
              <p className="mt-4 text-sm text-slate-700">
                Timezone saved: {savedZone}.
              </p>
            ) : null}
            {detectNote !== null ? (
              <p className="mt-4 text-sm text-slate-700">{detectNote}</p>
            ) : null}
          </div>

          {saveError !== null ? (
            <p
              id={errorId}
              role="alert"
              className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
            >
              {saveError}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
