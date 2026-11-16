// User settings: read the stored timezone, set it explicitly, or let detection
// fill it in. Same three steps per handler as `routes/tasks.ts` and nothing
// else — read the validated input through the validator that parsed it, call
// the service with the session's user id, shape the response. No business
// logic, no query, no try/catch.
//
// The two writes are two endpoints rather than one with a flag, because the
// flag would be the client naming which source it writes — exactly what the
// strict body schema refuses. As separate paths, neither can be talked into the
// other's semantics: `/` always records an explicit choice, `/detected` can
// only ever fill a zone that is still detected.
//
// Mounted below the `requireAuth` line in `app.ts`, so `userIdOf` always has a
// session user to report, and a client has no way to name the user it acts as.
import { Router } from "express";

import { userIdOf } from "../auth/requireAuth.js";
import { validate } from "../middleware/validate.js";
import {
  applyDetectedTimezone,
  getSettings,
  updateSettings,
} from "../services/settings.js";
import {
  detectTimezoneSchema,
  updateSettingsSchema,
} from "./settings.schema.js";

// One validator per schema, built once at module load, each owning a private
// slot on the request — as in `routes/tasks.ts`.
const validateUpdate = validate(updateSettingsSchema);
const validateDetected = validate(detectTimezoneSchema);

export const settingsRouter = Router();

settingsRouter.get("/", async (req, res) => {
  const settings = await getSettings(userIdOf(req));

  res.json(settings);
});

// PATCH rather than PUT: the body names the fields it changes, and the stored
// `timezoneSource` is not one a client may send.
settingsRouter.patch("/", validateUpdate, async (req, res) => {
  const settings = await updateSettings(
    userIdOf(req),
    validateUpdate.data(req),
  );

  // The stored settings come back rather than a 204: the write is what decides
  // `timezoneSource`, so the response is the client's only way to see it turn
  // explicit without a second round trip.
  res.json(settings);
});

// The browser's detected zone. 204 rather than the stored settings, and 204
// whether or not the write matched: a caller that is already `EXPLICIT` is the
// ordinary case, not an error, and detection cannot change the source either
// way — so there is nothing here the client could not already have known.
settingsRouter.patch("/detected", validateDetected, async (req, res) => {
  await applyDetectedTimezone(userIdOf(req), validateDetected.data(req));

  res.status(204).end();
});
