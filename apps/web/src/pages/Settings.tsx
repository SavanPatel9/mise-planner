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
import { getSettings, updateSettings } from "../api/settings";

/** The three states of `GET /api/settings`, and nothing else. */
type LoadState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; settings: UserSettings };

const LOAD_FAILED = "Couldn't load your settings. Please reload the page.";
const SAVE_FAILED = "Couldn't save your timezone. Please try again.";

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
  const selectId = useId();
  const errorId = useId();
  const saveRef = useRef<HTMLButtonElement>(null);
  const wasSaving = useRef(false);

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

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === null || saving) {
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSavedZone(null);

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

          <label
            htmlFor={selectId}
            className="mt-6 block text-sm font-medium text-slate-700"
          >
            Timezone
          </label>
          <select
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
            disabled={saving}
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
            disabled={saving}
            className="mt-6 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-slate-900"
          >
            {saving ? "Saving…" : "Save timezone"}
          </button>

          {/* Rendered unconditionally so the live region exists before it has
              anything to announce. */}
          <div role="status">
            {savedZone !== null ? (
              <p className="mt-4 text-sm text-slate-700">
                Timezone saved: {savedZone}.
              </p>
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
