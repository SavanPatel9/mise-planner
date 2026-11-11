// Task CRUD. Every handler is the same three steps and nothing else: read the
// validated input through the validator that parsed it, call the service with
// the session's user id, shape the response. No business logic, no query, no
// try/catch — Express 5 forwards a rejected promise from a handler to the error
// handler, which owns every error body.
//
// Mounted below the `requireAuth` line in `app.ts`, so `userIdOf` always has a
// session user to report. A client has no way to name the user it acts as: no
// handler here reads a user id out of the request.
import { Router } from "express";

import { userIdOf } from "../auth/requireAuth.js";
import { validate } from "../middleware/validate.js";
import {
  createTask,
  deleteTask,
  listTasks,
  updateTask,
} from "../services/tasks.js";
import {
  createTaskSchema,
  listTasksQuerySchema,
  taskIdParamsSchema,
  updateTaskSchema,
} from "./tasks.schema.js";

// One validator per schema-and-source, built once at module load. Each owns a
// private slot on the request, so the two mounted together on `PATCH /:id`
// cannot read each other's result.
const validateListQuery = validate(listTasksQuerySchema, "query");
const validateCreate = validate(createTaskSchema);
const validateUpdate = validate(updateTaskSchema);
const validateTaskId = validate(taskIdParamsSchema, "params");

export const tasksRouter = Router();

tasksRouter.get("/", validateListQuery, async (req, res) => {
  const tasks = await listTasks(userIdOf(req), validateListQuery.data(req));

  res.json(tasks);
});

tasksRouter.post("/", validateCreate, async (req, res) => {
  const task = await createTask(userIdOf(req), validateCreate.data(req));

  res.status(201).json(task);
});

// `:id` is validated ahead of the body so a malformed id is refused before
// anything reaches the database.
tasksRouter.patch("/:id", validateTaskId, validateUpdate, async (req, res) => {
  const task = await updateTask(
    userIdOf(req),
    validateTaskId.data(req).id,
    validateUpdate.data(req),
  );

  // The updated task comes back rather than a 204: the client's copy is stale
  // the moment it patches — `updatedAt` at least, and a status transition can
  // move more — and a round trip to re-read it is pure cost.
  res.json(task);
});

tasksRouter.delete("/:id", validateTaskId, async (req, res) => {
  await deleteTask(userIdOf(req), validateTaskId.data(req).id);

  res.status(204).end();
});
