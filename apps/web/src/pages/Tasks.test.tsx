import type { Task } from "@mise/shared";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Tasks } from "./Tasks";

const TASKS = "/api/tasks";

/**
 * Keyed by method as well as path, like the settings harness: this screen
 * reads and writes the same paths, and the answers are never the same.
 */
const LIST = `GET ${TASKS}`;
const CREATE = `POST ${TASKS}`;
const patchKey = (id: string) => `PATCH ${TASKS}/${id}`;
const deleteKey = (id: string) => `DELETE ${TASKS}/${id}`;

const fetchMock = vi.fn<typeof fetch>();

/** A handler per `METHOD /api/...`; anything unrouted is a test bug, not a 404. */
type Routes = Record<string, () => Promise<Response>>;

function route(routes: Routes): void {
  fetchMock.mockImplementation((input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const key = `${init?.method ?? "GET"} ${path}`;
    const handler = routes[key];
    if (handler === undefined) {
      return Promise.reject(new Error(`unrouted fetch: ${key}`));
    }

    return handler();
  });
}

function json(status: number, body: unknown): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

const ok = (body: unknown) => json(200, body);
const noContent = () => Promise.resolve(new Response(null, { status: 204 }));

/** A request that never reaches the server: what `fetch` itself rejects with. */
const offline = (): Promise<Response> =>
  Promise.reject(new TypeError("Failed to fetch"));

/** Lets a test hold a request in flight and assert the optimistic state. */
function deferred(): {
  promise: Promise<Response>;
  resolve: (value: Response) => void;
} {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A full task row as the API returns it; override what the test is about. */
function task(overrides: Partial<Task>): Task {
  return {
    id: "t1",
    title: "Prep mise",
    project: null,
    estimateMin: null,
    priority: 2,
    dueAt: null,
    status: "TODO",
    source: "MANUAL",
    deferCount: 0,
    createdAt: "2026-11-16T08:00:00.000Z",
    updatedAt: "2026-11-16T08:00:00.000Z",
    ...overrides,
  };
}

/** The named `section` for one status group (`aria-labelledby` names it). */
const group = (name: RegExp) => within(screen.getByRole("region", { name }));

/** To-do rows in document order — checkbox labels carry the titles. */
const todoOrder = () =>
  group(/to do/i)
    .getAllByRole("checkbox")
    .map((box) => box.getAttribute("aria-label"));

const titleInput = () => screen.getByRole("textbox", { name: "New task" });
const addButton = () => screen.getByRole("button", { name: /add task/i });

/** Resolves once `GET /api/tasks` has landed and the groups are on screen. */
const waitForList = () => screen.findByRole("heading", { name: /to do/i });

/** Every request this test issued matching `method` + `path`, in order. */
const callsTo = (method: string, path: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input) === path && (init?.method ?? "GET") === method,
  );

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("Tasks list rendering", () => {
  it("renders tasks grouped by status, with facts and the defer badge", async () => {
    route({
      [LIST]: ok([
        task({
          id: "t1",
          title: "Sharpen knives",
          project: "Kitchen",
          estimateMin: 25,
          deferCount: 2,
        }),
        task({ id: "t2", title: "Stock rotation", status: "IN_PROGRESS" }),
        task({ id: "t3", title: "Order produce", status: "DONE" }),
      ]),
    });

    render(<Tasks />);
    await waitForList();

    expect(group(/to do/i).getByText("Sharpen knives")).toBeInTheDocument();
    expect(
      group(/in progress/i).getByText("Stock rotation"),
    ).toBeInTheDocument();
    expect(group(/done/i).getByText("Order produce")).toBeInTheDocument();

    // The rollover signal the spec cares about, plus the row's facts.
    expect(screen.getByText("deferred ×2")).toBeInTheDocument();
    expect(screen.getByText("Kitchen")).toBeInTheDocument();
    expect(screen.getByText("25 min")).toBeInTheDocument();
  });

  it("shows no badge at deferCount 0 and keeps dropped tasks behind the toggle", async () => {
    route({
      [LIST]: ok([
        task({ id: "t1", title: "Sharpen knives" }),
        task({ id: "t2", title: "Old idea", status: "DROPPED" }),
      ]),
    });

    render(<Tasks />);
    await waitForList();

    expect(screen.queryByText(/deferred/)).not.toBeInTheDocument();

    // Dropped is noise on a working screen: present only behind the toggle.
    expect(screen.queryByText("Old idea")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /show dropped \(1\)/i }),
    );
    expect(screen.getByText("Old idea")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /hide dropped/i }));
    expect(screen.queryByText("Old idea")).not.toBeInTheDocument();
  });

  it("explains a list that failed to load", async () => {
    route({ [LIST]: offline });

    render(<Tasks />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't load your tasks/i,
    );
  });
});

describe("Tasks create", () => {
  it("appends an optimistic row and reconciles it from the response", async () => {
    const create = deferred();
    route({ [LIST]: ok([]), [CREATE]: () => create.promise });

    render(<Tasks />);
    await waitForList();

    fireEvent.change(titleInput(), { target: { value: "Prep stock" } });
    fireEvent.click(addButton());

    // On screen before the server answers, and the form is clear for the
    // next entry.
    expect(group(/to do/i).getByText("Prep stock")).toBeInTheDocument();
    expect(titleInput()).toHaveValue("");
    expect(fetchMock).toHaveBeenCalledWith(
      TASKS,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "Prep stock" }),
      }),
    );

    await act(async () => {
      create.resolve(
        jsonResponse(201, task({ id: "server-1", title: "Prep stock" })),
      );
      await create.promise;
    });

    // The server row replaced the optimistic one rather than joining it.
    expect(screen.getAllByText("Prep stock")).toHaveLength(1);
    expect(callsTo("GET", TASKS)).toHaveLength(1); // no re-fetch
  });

  it("renders a 400's field message on the form, drops the row, and restores the input", async () => {
    route({
      [LIST]: ok([]),
      [CREATE]: json(400, {
        error: "Validation failed",
        fields: { estimateMin: "Must be a positive whole number" },
      }),
    });

    render(<Tasks />);
    await waitForList();

    fireEvent.change(titleInput(), { target: { value: "Prep stock" } });
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Estimate (min)" }),
      {
        // Valid to the browser's own constraints — the refusal under test is
        // the server's, and jsdom blocks submit on a locally invalid form.
        target: { value: "2" },
      },
    );
    fireEvent.click(addButton());

    expect(
      await screen.findByText("Must be a positive whole number"),
    ).toBeInTheDocument();

    // The optimistic row rolled back, and the submission came back to the
    // form to be corrected rather than retyped.
    expect(group(/to do/i).queryByText("Prep stock")).not.toBeInTheDocument();
    expect(titleInput()).toHaveValue("Prep stock");
    const estimate = screen.getByRole("spinbutton", { name: "Estimate (min)" });
    expect(estimate).toHaveValue(2);
    expect(estimate).toHaveAttribute("aria-invalid", "true");
  });

  it("falls back to the generic line when the 400 names no rendered field", async () => {
    route({
      [LIST]: ok([]),
      [CREATE]: json(400, {
        error: "Validation failed",
        // The validator's root key: real (an empty-update refine files its
        // issue there) and rendered by no input on this form.
        fields: { _root: "Something about the whole payload" },
      }),
    });

    render(<Tasks />);
    await waitForList();

    fireEvent.change(titleInput(), { target: { value: "Prep stock" } });
    fireEvent.click(addButton());

    // The failure must not pass silently just because no input claims it.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something about the whole payload",
    );
    expect(group(/to do/i).queryByText("Prep stock")).not.toBeInTheDocument();
    expect(titleInput()).toHaveValue("Prep stock");
  });

  it("slots an optimistic create by the server's order, not append order", async () => {
    const create = deferred();
    route({
      [LIST]: ok([
        task({ id: "t1", title: "Undated" }),
        task({ id: "t2", title: "Low", priority: 3 }),
      ]),
      [CREATE]: () => create.promise,
    });

    render(<Tasks />);
    await waitForList();

    fireEvent.change(titleInput(), { target: { value: "Urgent" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), {
      target: { value: "1" },
    });
    fireEvent.click(addButton());

    // Appending would put the new row last; priority 1 belongs first. The
    // fixture is chosen so sorted order differs from append order — this
    // must fail if the insert stops sorting.
    expect(todoOrder()).toEqual([
      'Mark "Urgent" done',
      'Mark "Undated" done',
      'Mark "Low" done',
    ]);

    await act(async () => {
      create.resolve(
        jsonResponse(
          201,
          task({ id: "server-9", title: "Urgent", priority: 1 }),
        ),
      );
      await create.promise;
    });

    expect(todoOrder()).toEqual([
      'Mark "Urgent" done',
      'Mark "Undated" done',
      'Mark "Low" done',
    ]);
  });

  it("re-sorts when the reconciled row gains a due date (undated last)", async () => {
    route({
      [LIST]: ok([
        task({
          id: "t1",
          title: "First",
          createdAt: "2026-11-16T08:00:00.000Z",
        }),
        task({
          id: "t2",
          title: "Second",
          createdAt: "2026-11-16T09:00:00.000Z",
        }),
      ]),
      [patchKey("t2")]: ok(
        task({
          id: "t2",
          title: "Second",
          createdAt: "2026-11-16T09:00:00.000Z",
          dueAt: "2026-11-17T09:00:00.000Z",
        }),
      ),
    });

    render(<Tasks />);
    await waitForList();

    expect(todoOrder()).toEqual(['Mark "First" done', 'Mark "Second" done']);

    // A no-change save: the response is authoritative, and here it carries a
    // due date the optimistic row didn't have — equal priority, so the dated
    // row must move above the undated one on reconcile.
    fireEvent.click(screen.getByRole("button", { name: 'Edit "Second"' }));
    fireEvent.click(screen.getByRole("button", { name: 'Save "Second"' }));

    await waitFor(() => {
      expect(todoOrder()).toEqual(['Mark "Second" done', 'Mark "First" done']);
    });
  });
});

describe("Tasks focus management", () => {
  it("returns focus to the Add button once a create settles", async () => {
    const create = deferred();
    route({ [LIST]: ok([]), [CREATE]: () => create.promise });

    render(<Tasks />);
    await waitForList();

    fireEvent.change(titleInput(), { target: { value: "Prep stock" } });
    fireEvent.click(addButton());
    // Focus sits on `body`, as it would in a browser after the disabled
    // button dropped it.
    expect(document.body).toHaveFocus();

    await act(async () => {
      create.resolve(
        jsonResponse(201, task({ id: "s1", title: "Prep stock" })),
      );
      await create.promise;
    });

    expect(addButton()).toHaveFocus();
  });

  it("leaves focus alone when the user moved on during the create", async () => {
    const create = deferred();
    route({
      [LIST]: ok([task({ id: "t1", title: "Alpha" })]),
      [CREATE]: () => create.promise,
    });

    render(<Tasks />);
    await waitForList();

    fireEvent.change(titleInput(), { target: { value: "Prep stock" } });
    fireEvent.click(addButton());
    const edit = screen.getByRole("button", { name: 'Edit "Alpha"' });
    edit.focus();

    await act(async () => {
      create.resolve(
        jsonResponse(201, task({ id: "s1", title: "Prep stock" })),
      );
      await create.promise;
    });

    // The user meant to be on that button; the settle must not steal it.
    expect(edit).toHaveFocus();
    expect(addButton()).not.toHaveFocus();
  });

  it("returns focus to the row's Edit button once its save settles", async () => {
    const patch = deferred();
    route({
      [LIST]: ok([task({ id: "t1", title: "Alpha" })]),
      [patchKey("t1")]: () => patch.promise,
    });

    render(<Tasks />);
    await waitForList();

    fireEvent.click(screen.getByRole("button", { name: 'Edit "Alpha"' }));
    fireEvent.click(screen.getByRole("button", { name: 'Save "Alpha"' }));
    expect(document.body).toHaveFocus();

    await act(async () => {
      patch.resolve(jsonResponse(200, task({ id: "t1", title: "Alpha" })));
      await patch.promise;
    });

    expect(screen.getByRole("button", { name: 'Edit "Alpha"' })).toHaveFocus();
  });
});

describe("Tasks status changes", () => {
  it("completes a task optimistically and reconciles from the PATCH response", async () => {
    route({
      [LIST]: ok([task({ id: "t1", title: "Sharpen knives" })]),
      [patchKey("t1")]: ok(
        task({ id: "t1", title: "Sharpen knives", status: "DONE" }),
      ),
    });

    render(<Tasks />);
    await waitForList();

    fireEvent.click(
      screen.getByRole("checkbox", { name: 'Mark "Sharpen knives" done' }),
    );

    expect(
      await group(/done/i).findByText("Sharpen knives"),
    ).toBeInTheDocument();
    expect(
      group(/to do/i).queryByText("Sharpen knives"),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `${TASKS}/t1`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "DONE" }),
      }),
    );
    expect(callsTo("GET", TASKS)).toHaveLength(1); // no re-fetch
  });

  it("rolls a failed status change back and explains it", async () => {
    const patch = deferred();
    route({
      [LIST]: ok([task({ id: "t1", title: "Sharpen knives" })]),
      [patchKey("t1")]: () => patch.promise,
    });

    render(<Tasks />);
    await waitForList();

    fireEvent.click(
      screen.getByRole("checkbox", { name: 'Mark "Sharpen knives" done' }),
    );

    // Optimistically done while the request is in flight...
    expect(group(/done/i).getByText("Sharpen knives")).toBeInTheDocument();

    await act(async () => {
      patch.resolve(jsonResponse(500, { error: "Internal error" }));
      await patch.promise;
    });

    // ...and back where it started once the server refused, with copy.
    expect(group(/to do/i).getByText("Sharpen knives")).toBeInTheDocument();
    expect(
      group(/done/i).queryByText("Sharpen knives"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /couldn't save that change/i,
    );
    expect(
      screen.getByRole("checkbox", { name: 'Mark "Sharpen knives" done' }),
    ).toBeEnabled();
  });

  it("freezes only the in-flight row and rolls back just that row", async () => {
    const patchAlpha = deferred();
    route({
      [LIST]: ok([
        task({ id: "t1", title: "Alpha" }),
        task({ id: "t2", title: "Beta" }),
      ]),
      [patchKey("t1")]: () => patchAlpha.promise,
      [patchKey("t2")]: ok(task({ id: "t2", title: "Beta", status: "DONE" })),
    });

    render(<Tasks />);
    await waitForList();

    fireEvent.click(
      screen.getByRole("checkbox", { name: 'Mark "Alpha" done' }),
    );

    // Alpha's row is frozen while its request is out; Beta's is untouched
    // and completes independently.
    expect(
      screen.getByRole("checkbox", { name: 'Mark "Alpha" not done' }),
    ).toBeDisabled();
    const betaBox = screen.getByRole("checkbox", { name: 'Mark "Beta" done' });
    expect(betaBox).toBeEnabled();
    fireEvent.click(betaBox);
    expect(await group(/done/i).findByText("Beta")).toBeInTheDocument();

    await act(async () => {
      patchAlpha.resolve(jsonResponse(500, { error: "Internal error" }));
      await patchAlpha.promise;
    });

    // Alpha alone rolled back; Beta's landed result survived it.
    expect(group(/to do/i).getByText("Alpha")).toBeInTheDocument();
    expect(group(/done/i).getByText("Beta")).toBeInTheDocument();
    expect(group(/done/i).queryByText("Alpha")).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: 'Mark "Alpha" done' }),
    ).toBeEnabled();
  });

  it("explains a 429 from the rate limiter in plain copy", async () => {
    route({
      [LIST]: ok([task({ id: "t1", title: "Sharpen knives" })]),
      [patchKey("t1")]: json(429, { error: "Too many requests" }),
    });

    render(<Tasks />);
    await waitForList();

    fireEvent.click(
      screen.getByRole("checkbox", { name: 'Mark "Sharpen knives" done' }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /too many requests right now/i,
    );
    expect(group(/to do/i).getByText("Sharpen knives")).toBeInTheDocument();
  });
});

describe("Tasks inline edit", () => {
  it("saves an edit optimistically and shows the server's row", async () => {
    route({
      [LIST]: ok([
        task({ id: "t1", title: "Sharpen knives", project: "Kitchen" }),
      ]),
      [patchKey("t1")]: ok(
        task({ id: "t1", title: "Sharpen all knives", project: "Kitchen" }),
      ),
    });

    render(<Tasks />);
    await waitForList();

    fireEvent.click(
      screen.getByRole("button", { name: 'Edit "Sharpen knives"' }),
    );
    const editTitle = screen.getByRole("textbox", { name: "Title" });
    expect(editTitle).toHaveValue("Sharpen knives");

    fireEvent.change(editTitle, { target: { value: "Sharpen all knives" } });
    fireEvent.click(
      screen.getByRole("button", { name: 'Save "Sharpen knives"' }),
    );

    // Editor closed, optimistic title on screen before the server answers.
    expect(
      screen.queryByRole("textbox", { name: "Title" }),
    ).not.toBeInTheDocument();
    expect(group(/to do/i).getByText("Sharpen all knives")).toBeInTheDocument();

    const [, init] = callsTo("PATCH", `${TASKS}/t1`)[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Sharpen all knives",
      project: "Kitchen",
      estimateMin: null,
      priority: 2,
      dueAt: null,
    });

    expect(
      await group(/to do/i).findByText("Sharpen all knives"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Sharpen all knives")).toHaveLength(1);
  });
});

describe("Tasks delete", () => {
  it("deletes only after the confirm affordance, and not on cancel", async () => {
    route({
      [LIST]: ok([task({ id: "t1", title: "Old prep list" })]),
      [deleteKey("t1")]: noContent,
    });

    render(<Tasks />);
    await waitForList();

    // Arm, then cancel: nothing leaves.
    fireEvent.click(
      screen.getByRole("button", { name: 'Delete "Old prep list"' }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: 'Cancel deleting "Old prep list"' }),
    );
    expect(screen.getByText("Old prep list")).toBeInTheDocument();
    expect(callsTo("DELETE", `${TASKS}/t1`)).toHaveLength(0);

    // Arm, then confirm: the row goes optimistically and the call is made.
    fireEvent.click(
      screen.getByRole("button", { name: 'Delete "Old prep list"' }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: 'Confirm deleting "Old prep list"' }),
    );
    expect(screen.queryByText("Old prep list")).not.toBeInTheDocument();
    expect(callsTo("DELETE", `${TASKS}/t1`)).toHaveLength(1);
  });

  it("restores the row when the delete fails", async () => {
    route({
      [LIST]: ok([task({ id: "t1", title: "Old prep list" })]),
      [deleteKey("t1")]: offline,
    });

    render(<Tasks />);
    await waitForList();

    fireEvent.click(
      screen.getByRole("button", { name: 'Delete "Old prep list"' }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: 'Confirm deleting "Old prep list"' }),
    );
    expect(screen.queryByText("Old prep list")).not.toBeInTheDocument();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't delete the task/i,
    );
    expect(group(/to do/i).getByText("Old prep list")).toBeInTheDocument();
  });
});
