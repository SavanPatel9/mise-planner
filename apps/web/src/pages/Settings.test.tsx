import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Settings } from "./Settings";

const SETTINGS = "/api/settings";

/**
 * Keyed by method as well as path, unlike the shell's harness in
 * `App.test.tsx`: this screen reads and writes the same path, and the two
 * answers are never the same.
 */
const LOAD = `GET ${SETTINGS}`;
const SAVE = `PATCH ${SETTINGS}`;

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

/** The stored settings, as `GET` and a successful `PATCH` both return them. */
const stored = (timezone: string, timezoneSource = "EXPLICIT") =>
  ok({ timezone, timezoneSource });

/** Answers in order; the last one stands for every call after it. */
function sequence(
  ...handlers: (() => Promise<Response>)[]
): () => Promise<Response> {
  let call = 0;
  return () => {
    const handler = handlers[Math.min(call, handlers.length - 1)];
    call += 1;
    return (handler as () => Promise<Response>)();
  };
}

/** A request that never reaches the server: what `fetch` itself rejects with. */
const offline = (): Promise<Response> =>
  Promise.reject(new TypeError("Failed to fetch"));

/** The body the API sends when its zone refinement rejects the sent name. */
const rejectedZone = json(400, {
  error: "Validation failed",
  fields: { timezone: "Unknown IANA time zone" },
});

/** Plain apostrophes: unlike the shell's copy, these are string constants. */
const LOAD_FAILED = "Couldn't load your settings. Please reload the page.";
const SAVE_FAILED = "Couldn't save your timezone. Please try again.";
const UNKNOWN_ZONE = "Unknown IANA time zone";

/** Lets a test hold a request in flight and assert the pending state. */
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

const settingsResponse = (timezone: string, timezoneSource = "EXPLICIT") =>
  new Response(JSON.stringify({ timezone, timezoneSource }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const picker = () => screen.getByRole("combobox", { name: "Timezone" });
const saveButton = () => screen.getByRole("button", { name: /save timezone/i });

/** Resolves once the form is on screen, i.e. `GET /api/settings` has landed. */
const waitForForm = () => screen.findByRole("combobox", { name: "Timezone" });

/** Every `PATCH /api/settings` this test issued, in order. */
const saveCalls = () =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");

/** The zone the page says is stored right now. */
function currentZone(): string {
  const line = screen.getByText(/current timezone:/i);
  return (line.textContent ?? "").replace(/^Current timezone:\s*/, "");
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("Settings load", () => {
  it("shows the loading state until GET /api/settings answers, then the zone", async () => {
    const load = deferred();
    route({ [LOAD]: () => load.promise });

    render(<Settings />);

    expect(screen.getByRole("status")).toHaveTextContent(/loading settings/i);
    expect(
      screen.queryByRole("combobox", { name: "Timezone" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      load.resolve(settingsResponse("America/Chicago", "DETECTED"));
      await load.promise;
    });

    expect(await waitForForm()).toHaveValue("America/Chicago");
    expect(currentZone()).toBe("America/Chicago");
    expect(screen.queryByText(/loading settings/i)).not.toBeInTheDocument();
  });

  it("offers the stored zone as an option even when it is a non-canonical alias", async () => {
    // `Intl.supportedValuesOf` lists canonical names only, so an aliased stored
    // zone has to be folded in or the controlled `select` shows nothing picked.
    route({ [LOAD]: stored("Asia/Calcutta") });

    render(<Settings />);

    expect(await waitForForm()).toHaveValue("Asia/Calcutta");
    expect(
      screen.getByRole("option", { name: "Asia/Calcutta" }),
    ).toBeInTheDocument();
  });

  it("warns and offers no picker when the load 500s", async () => {
    route({ [LOAD]: json(500, { error: "Internal error" }) });

    render(<Settings />);

    expect(await screen.findByRole("alert")).toHaveTextContent(LOAD_FAILED);
    // Nothing to save against: a picker here would submit an invented zone
    // over a stored one nobody has read.
    expect(
      screen.queryByRole("combobox", { name: "Timezone" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /save timezone/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/loading settings/i)).not.toBeInTheDocument();
  });

  it("uses the same warning when the load never reaches the server", async () => {
    route({ [LOAD]: offline });

    render(<Settings />);

    expect(await screen.findByRole("alert")).toHaveTextContent(LOAD_FAILED);
    expect(
      screen.queryByRole("combobox", { name: "Timezone" }),
    ).not.toBeInTheDocument();
  });
});

describe("Settings save", () => {
  it("PATCHes the chosen zone and announces the save accessibly", async () => {
    route({
      [LOAD]: stored("UTC", "DETECTED"),
      [SAVE]: stored("Europe/Paris"),
    });

    render(<Settings />);
    const select = await waitForForm();
    fireEvent.change(select, { target: { value: "Europe/Paris" } });
    expect(select).toHaveValue("Europe/Paris");

    fireEvent.click(saveButton());

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Timezone saved: Europe/Paris.",
    );
    expect(saveCalls()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      SETTINGS,
      expect.objectContaining({
        method: "PATCH",
        credentials: "include",
        body: JSON.stringify({ timezone: "Europe/Paris" }),
      }),
    );
    // The stored line has to follow the write, or the page still reads as the
    // zone the user just replaced.
    expect(currentZone()).toBe("Europe/Paris");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("adopts the zone the server stored rather than the one submitted", async () => {
    route({
      [LOAD]: stored("UTC", "DETECTED"),
      // The API canonicalises: an alias in, the canonical name out.
      [SAVE]: stored("Asia/Kolkata"),
    });

    render(<Settings />);
    const select = await waitForForm();
    fireEvent.change(select, { target: { value: "Asia/Calcutta" } });
    fireEvent.click(saveButton());

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Timezone saved: Asia/Kolkata.",
    );
    expect(currentZone()).toBe("Asia/Kolkata");
    expect(picker()).toHaveValue("Asia/Kolkata");
  });

  it("saves an unchanged selection, which is how a detected zone is confirmed", async () => {
    route({
      [LOAD]: stored("America/Chicago", "DETECTED"),
      [SAVE]: stored("America/Chicago"),
    });

    render(<Settings />);
    await waitForForm();
    // No change event at all: the button must not gate on a dirty selection,
    // since confirming the guess is the whole point of the screen.
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Timezone saved: America/Chicago.",
    );
    expect(saveCalls()).toHaveLength(1);
    expect(JSON.parse(String(saveCalls()[0]?.[1]?.body))).toEqual({
      timezone: "America/Chicago",
    });
  });

  it("disables the picker and the button in flight, spending one request", async () => {
    const save = deferred();
    route({ [LOAD]: stored("UTC", "DETECTED"), [SAVE]: () => save.promise });

    render(<Settings />);
    const select = await waitForForm();
    fireEvent.change(select, { target: { value: "Europe/Paris" } });
    fireEvent.click(saveButton());

    expect(select).toBeDisabled();
    const button = screen.getByRole("button", { name: /saving/i });
    expect(button).toBeDisabled();
    // An impatient second submit must not issue a second write, even if the
    // form is submitted around the disabled button.
    fireEvent.click(button);
    fireEvent.submit(button.closest("form") as HTMLFormElement);
    expect(saveCalls()).toHaveLength(1);

    await act(async () => {
      save.resolve(settingsResponse("Europe/Paris"));
      await save.promise;
    });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Timezone saved: Europe/Paris.",
    );
    expect(picker()).toBeEnabled();
    expect(saveButton()).toBeEnabled();
    expect(saveCalls()).toHaveLength(1);
    // `disabled` evicted focus to `body` when the request started; leaving it
    // there would make a keyboard user tab from the top of the document.
    expect(saveButton()).toHaveFocus();
  });

  it("restores focus to the button after a refused save", async () => {
    route({ [LOAD]: stored("UTC", "DETECTED"), [SAVE]: rejectedZone });

    render(<Settings />);
    await waitForForm();
    fireEvent.click(saveButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(UNKNOWN_ZONE);
    // The refusal renders after the button in the DOM, so focus on the button
    // reaches it with one Tab instead of a tab from `body`.
    expect(saveButton()).toHaveFocus();
  });

  it("leaves focus alone when the user moved it while the save was in flight", async () => {
    const save = deferred();
    route({ [LOAD]: stored("UTC", "DETECTED"), [SAVE]: () => save.promise });

    render(<Settings />);
    await waitForForm();
    fireEvent.click(saveButton());

    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();

    await act(async () => {
      save.resolve(settingsResponse("UTC"));
      await save.promise;
    });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Timezone saved: UTC.",
    );
    // Taking focus back from wherever the user went is theft, not recovery.
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });

  it("shows a rejected zone as the picker's description and keeps the choice", async () => {
    route({ [LOAD]: stored("UTC", "DETECTED"), [SAVE]: rejectedZone });

    render(<Settings />);
    const select = await waitForForm();
    fireEvent.change(select, { target: { value: "Europe/Paris" } });
    fireEvent.click(saveButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(UNKNOWN_ZONE);
    // Tied to the control, not merely nearby: a screen reader reaching the
    // picker has to hear why the last attempt was refused.
    expect(picker()).toHaveAccessibleDescription(UNKNOWN_ZONE);
    expect(picker()).toHaveAttribute("aria-invalid", "true");
    // Theirs to correct: resetting the picker would hide what was refused.
    expect(picker()).toHaveValue("Europe/Paris");
    expect(saveButton()).toBeEnabled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    // The refused write changed nothing, so the stored line must not move.
    expect(currentZone()).toBe("UTC");
  });

  it("falls back to generic copy when the save fails for a reason not the user's", async () => {
    route({
      [LOAD]: stored("UTC", "DETECTED"),
      [SAVE]: json(500, { error: "Internal error" }),
    });

    render(<Settings />);
    await waitForForm();
    fireEvent.click(saveButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
    // The server's own wording for a 500 is not the user's business.
    expect(screen.queryByText(/internal error/i)).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it("uses the generic copy when the save never reaches the server", async () => {
    route({ [LOAD]: stored("UTC", "DETECTED"), [SAVE]: offline });

    render(<Settings />);
    await waitForForm();
    fireEvent.click(saveButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
    expect(saveButton()).toBeEnabled();
  });

  it("clears the refusal when the retry lands", async () => {
    route({
      [LOAD]: stored("UTC", "DETECTED"),
      [SAVE]: sequence(rejectedZone, stored("Europe/Paris")),
    });

    render(<Settings />);
    const select = await waitForForm();
    fireEvent.change(select, { target: { value: "Europe/Paris" } });
    fireEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(UNKNOWN_ZONE);

    fireEvent.click(saveButton());

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Timezone saved: Europe/Paris.",
    );
    // A stale refusal left on the control would mark a saved zone invalid.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(picker()).toHaveAttribute("aria-invalid", "false");
    expect(picker()).not.toHaveAccessibleDescription(UNKNOWN_ZONE);
  });

  it("clears a refusal as soon as the selection changes", async () => {
    route({ [LOAD]: stored("UTC", "DETECTED"), [SAVE]: rejectedZone });

    render(<Settings />);
    const select = await waitForForm();
    fireEvent.change(select, { target: { value: "Europe/Paris" } });
    fireEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(UNKNOWN_ZONE);

    fireEvent.change(picker(), { target: { value: "Asia/Tokyo" } });

    // The refusal described the zone that was refused: carrying it over marks
    // a correction the server has never seen as invalid.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(picker()).toHaveAttribute("aria-invalid", "false");
    expect(picker()).not.toHaveAccessibleDescription(UNKNOWN_ZONE);
  });

  it("clears the success line as soon as the selection changes", async () => {
    route({
      [LOAD]: stored("UTC", "DETECTED"),
      [SAVE]: stored("Europe/Paris"),
    });

    render(<Settings />);
    const select = await waitForForm();
    fireEvent.change(select, { target: { value: "Europe/Paris" } });
    fireEvent.click(saveButton());
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Timezone saved: Europe/Paris.",
    );

    fireEvent.change(picker(), { target: { value: "Asia/Tokyo" } });

    // "Timezone saved: Europe/Paris" next to a picker reading Asia/Tokyo
    // claims a save that never happened.
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(currentZone()).toBe("Europe/Paris");
  });

  it("clears the previous success line when a later save is refused", async () => {
    route({
      [LOAD]: stored("UTC", "DETECTED"),
      [SAVE]: sequence(stored("Europe/Paris"), rejectedZone),
    });

    render(<Settings />);
    const select = await waitForForm();
    fireEvent.change(select, { target: { value: "Europe/Paris" } });
    fireEvent.click(saveButton());
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Timezone saved: Europe/Paris.",
    );

    fireEvent.change(picker(), { target: { value: "Asia/Tokyo" } });
    fireEvent.click(saveButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(UNKNOWN_ZONE);
    // "Timezone saved" standing next to a refusal reads as both at once.
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(picker()).toHaveValue("Asia/Tokyo");
    expect(currentZone()).toBe("Europe/Paris");
  });
});
