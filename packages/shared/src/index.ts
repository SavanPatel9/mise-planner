// Type-only re-export on purpose: the API resolves `@mise/shared` through the
// tsconfig path to this file, with no build step, so a runtime value export
// here would have to exist in `dist/` to survive the import.
export type { AuthErrorFlag, MeResponse } from "./auth.js";
export type {
  DetectTimezoneInput,
  Settings,
  TimezoneSource,
  UpdateSettingsInput,
} from "./settings.js";
export type {
  CreateTaskInput,
  Task,
  TaskPriority,
  TaskSource,
  TaskStatus,
  UpdateTaskInput,
} from "./task.js";

/**
 * Error body returned by every API endpoint on failure.
 * `fields` carries per-field validation messages when the error is a 400.
 */
export interface ApiError {
  error: string;
  fields?: Record<string, string>;
}
