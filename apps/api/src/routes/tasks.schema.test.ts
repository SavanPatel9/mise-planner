import { describe, expect, it } from "vitest";

import {
  createTaskSchema,
  listTasksQuerySchema,
  updateTaskSchema,
} from "./tasks.schema.js";

describe("createTaskSchema", () => {
  it("parses a minimal valid payload with only the required field", () => {
    const result = createTaskSchema.safeParse({ title: "Write tests" });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ title: "Write tests" });
  });

  it("parses a fully populated payload", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      project: "mise",
      estimateMin: 30,
      priority: 1,
      dueAt: "2026-11-10T12:00:00Z",
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      title: "Write tests",
      project: "mise",
      estimateMin: 30,
      priority: 1,
      dueAt: "2026-11-10T12:00:00Z",
    });
  });

  it("trims whitespace from the title", () => {
    const result = createTaskSchema.safeParse({ title: "  Write tests  " });

    expect(result.success).toBe(true);
    expect(result.data?.title).toBe("Write tests");
  });

  it("trims whitespace from project", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      project: "  mise  ",
    });

    expect(result.success).toBe(true);
    expect(result.data?.project).toBe("mise");
  });

  it("rejects an empty project", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      project: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only project rather than storing it as an empty string", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      project: "   ",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a project over the max length", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      project: "a".repeat(201),
    });

    expect(result.success).toBe(false);
  });

  it("accepts a project at exactly the max length", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      project: "a".repeat(200),
    });

    expect(result.success).toBe(true);
  });

  it("rejects a missing title", () => {
    const result = createTaskSchema.safeParse({});

    expect(result.success).toBe(false);
  });

  it("rejects an empty title", () => {
    const result = createTaskSchema.safeParse({ title: "" });

    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only title", () => {
    const result = createTaskSchema.safeParse({ title: "   " });

    expect(result.success).toBe(false);
  });

  it("rejects a title over the max length", () => {
    const result = createTaskSchema.safeParse({ title: "a".repeat(501) });

    expect(result.success).toBe(false);
  });

  it("accepts a title at exactly the max length", () => {
    const result = createTaskSchema.safeParse({ title: "a".repeat(500) });

    expect(result.success).toBe(true);
  });

  it("rejects an unknown field", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      notAField: "oops",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.code === "unrecognized_keys"),
      ).toBe(true);
    }
  });

  it.each([0, 4, 1.5, -1])("rejects priority %s", (priority) => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      priority,
    });

    expect(result.success).toBe(false);
  });

  it.each([1, 2, 3])("accepts priority %i", (priority) => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      priority,
    });

    expect(result.success).toBe(true);
  });

  it("rejects estimateMin of 0", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      estimateMin: 0,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a negative estimateMin", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      estimateMin: -5,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a non-integer estimateMin", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      estimateMin: 12.5,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an estimateMin beyond int32 — it would overflow the column", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      estimateMin: 2_147_483_648,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a malformed dueAt", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      dueAt: "not-a-date",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a bare-local dueAt with no offset", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      dueAt: "2026-11-10T12:00:00",
    });

    expect(result.success).toBe(false);
  });

  it("accepts a dueAt with a Z suffix", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      dueAt: "2026-11-10T12:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });

  it("rejects a numeric-offset dueAt — only Z, the shape Date#toISOString() produces, is accepted", () => {
    const result = createTaskSchema.safeParse({
      title: "Write tests",
      dueAt: "2026-11-10T12:00:00+05:00",
    });

    expect(result.success).toBe(false);
  });

  // Nothing to clear on a create, so `null` is a client bug on every field the
  // update schema accepts it for.
  it.each(["project", "estimateMin", "dueAt"])(
    "rejects %s: null (not nullable on create)",
    (field) => {
      const result = createTaskSchema.safeParse({
        title: "Write tests",
        [field]: null,
      });

      expect(result.success).toBe(false);
    },
  );
});

describe("updateTaskSchema", () => {
  it("accepts a single-field update", () => {
    const result = updateTaskSchema.safeParse({ title: "Renamed" });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ title: "Renamed" });
  });

  it.each(["project", "estimateMin", "dueAt"])(
    "accepts %s: null to clear the field",
    (field) => {
      const result = updateTaskSchema.safeParse({ [field]: null });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ [field]: null });
    },
  );

  it("accepts a null for all three clearable fields at once", () => {
    const result = updateTaskSchema.safeParse({
      project: null,
      estimateMin: null,
      dueAt: null,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      project: null,
      estimateMin: null,
      dueAt: null,
    });
  });

  it("rejects status: null — a status is never absent, so there is nothing to clear", () => {
    const result = updateTaskSchema.safeParse({ status: null });

    expect(result.success).toBe(false);
  });

  it("rejects an empty project — only null clears it", () => {
    const result = updateTaskSchema.safeParse({ project: "" });

    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only project — only null clears it", () => {
    const result = updateTaskSchema.safeParse({ project: "   " });

    expect(result.success).toBe(false);
  });

  it("trims a project it accepts", () => {
    const result = updateTaskSchema.safeParse({ project: "  mise  " });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ project: "mise" });
  });

  it("rejects an empty update object — a patch naming no field cannot be served", () => {
    const result = updateTaskSchema.safeParse({});

    expect(result.success).toBe(false);
    if (!result.success) {
      // Empty path: the check is on the whole object, which is what the
      // validate middleware reports under `ROOT_FIELD_KEY`.
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.path).toEqual([]);
      expect(result.error.issues[0]?.message).toBe(
        "Provide at least one field to update",
      );
    }
  });

  it("rejects an update whose only key is undefined — Prisma would ignore it", () => {
    const result = updateTaskSchema.safeParse({ title: undefined });

    expect(result.success).toBe(false);
  });

  it("accepts a status transition", () => {
    const result = updateTaskSchema.safeParse({ status: "DONE" });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ status: "DONE" });
  });

  it("rejects an invalid status", () => {
    const result = updateTaskSchema.safeParse({ status: "ARCHIVED" });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown field", () => {
    const result = updateTaskSchema.safeParse({ notAField: "oops" });

    expect(result.success).toBe(false);
  });

  it("rejects an empty title when provided", () => {
    const result = updateTaskSchema.safeParse({ title: "" });

    expect(result.success).toBe(false);
  });

  it("rejects title: null — a task always has a title", () => {
    const result = updateTaskSchema.safeParse({ title: null });

    expect(result.success).toBe(false);
  });

  it("rejects out-of-range priority when provided", () => {
    const result = updateTaskSchema.safeParse({ priority: 0 });

    expect(result.success).toBe(false);
  });
});

describe("listTasksQuerySchema", () => {
  it("accepts an empty query", () => {
    const result = listTasksQuerySchema.safeParse({});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({});
  });

  it.each(["TODO", "IN_PROGRESS", "DONE", "DROPPED"])(
    "accepts status=%s",
    (status) => {
      const result = listTasksQuerySchema.safeParse({ status });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ status });
    },
  );

  it("rejects an invalid status", () => {
    const result = listTasksQuerySchema.safeParse({ status: "BOGUS" });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown query field", () => {
    const result = listTasksQuerySchema.safeParse({
      status: "TODO",
      sort: "dueAt",
    });

    expect(result.success).toBe(false);
  });
});
