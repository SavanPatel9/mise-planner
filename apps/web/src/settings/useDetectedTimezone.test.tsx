import { act, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDetectedTimezone } from "./useDetectedTimezone";

const SETTINGS = "/api/settings";
const DETECTED = "/api/settings/detected";

/**
 * The zone this run's JavaScript engine reports — the same value the hook
 * reads. Computed rather than stubbed so the test asserts on the real
 * detection, and so a machine or CI runner in any zone agrees with it.
 */
const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A zone that is certainly not the browser's, whatever the browser's is. */
const OTHER_ZONE = BROWSER_ZONE === "UTC" ? "Europe/Paris" : "UTC";

const fetchMock = vi.fn<typeof fetch>();

/** A handler per `/api/...` path; anything unrouted is a test bug, not a 404. */
type Routes = Record<string, () => Promise<Response>>;

function route(routes: Routes): void {
  fetchMock.mockImplementation((input) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const handler = routes[path];
    if (handler === undefined) {
      return Promise.reject(new Error(`unrouted fetch: ${path}`));
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

/** `GET /api/settings`, as the API answers it. */
const settings = (timezone: string, timezoneSource: string) =>
  json(200, { timezone, timezoneSource });

/** What `PATCH /api/settings/detected` returns: nothing, either way. */
const noContent = () => Promise.resolve(new Response(null, { status: 204 }));

/** A request that never reaches the server: what `fetch` itself rejects with. */
const offline = (): Promise<Response> =>
  Promise.reject(new TypeError("Failed to fetch"));

/** The hook's only consumer-visible surface is that it renders nothing. */
function Probe() {
  useDetectedTimezone();

  return <p>today</p>;
}

const callsTo = (path: string) =>
  fetchMock.mock.calls.filter(([input]) => String(input) === path);

/**
 * Drains every pending microtask by waiting a macrotask: the hook's work is a
 * chain of awaits with no timers, so after this it has either written or
 * decided not to. Needed before asserting that no write happened — a write
 * that is merely late is still a write.
 */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });

/** Nothing about this bookkeeping may reach the screen. */
function expectSilent(): void {
  expect(screen.getByText("today")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByText(/timezone/i)).not.toBeInTheDocument();
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

describe("useDetectedTimezone", () => {
  it("offers the browser's zone when the stored one is still a guess", async () => {
    route({
      [SETTINGS]: settings(OTHER_ZONE, "DETECTED"),
      [DETECTED]: noContent,
    });

    render(<Probe />);
    await settle();

    expect(callsTo(DETECTED)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      DETECTED,
      expect.objectContaining({
        method: "PATCH",
        credentials: "include",
        body: JSON.stringify({ timezone: BROWSER_ZONE }),
      }),
    );
    // Never the explicit endpoint: that would record a guess as the user's
    // choice and freeze their zone wherever they first signed in.
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input) === SETTINGS && init?.method,
      ),
    ).toHaveLength(0);
    expectSilent();
  });

  it("writes once under StrictMode, which mounts the effect twice", async () => {
    route({
      [SETTINGS]: settings(OTHER_ZONE, "DETECTED"),
      [DETECTED]: noContent,
    });

    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await settle();

    // Two passes racing one write is how a double PATCH, or a write ordered
    // behind a stale read, gets into production.
    expect(callsTo(SETTINGS)).toHaveLength(1);
    expect(callsTo(DETECTED)).toHaveLength(1);
  });

  it("leaves an explicit choice alone", async () => {
    route({ [SETTINGS]: settings(OTHER_ZONE, "EXPLICIT") });

    render(<Probe />);
    await settle();

    // Unrouted here on purpose: a write would reject and be swallowed, so the
    // count is the only thing that can catch it.
    expect(callsTo(DETECTED)).toHaveLength(0);
    expect(callsTo(SETTINGS)).toHaveLength(1);
    expectSilent();
  });

  it("spends no request when the stored guess already matches the browser", async () => {
    route({ [SETTINGS]: settings(BROWSER_ZONE, "DETECTED") });

    render(<Probe />);
    await settle();

    expect(callsTo(DETECTED)).toHaveLength(0);
  });

  it("spends no request when the engine reports no zone at all", async () => {
    const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(
      Intl.DateTimeFormat.prototype,
      "resolvedOptions",
    ).mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...resolvedOptions.call(this), timeZone: "" };
    });
    route({ [SETTINGS]: settings(OTHER_ZONE, "DETECTED") });

    render(<Probe />);
    await settle();

    // An empty zone would fail the API's refinement anyway; sending it would
    // only spend a request to be told so.
    expect(callsTo(DETECTED)).toHaveLength(0);
  });

  it("stays silent when the settings read 500s", async () => {
    route({ [SETTINGS]: json(500, { error: "Internal error" }) });

    render(<Probe />);
    await settle();

    expect(callsTo(DETECTED)).toHaveLength(0);
    expectSilent();
  });

  it("stays silent when the settings read never reaches the server", async () => {
    route({ [SETTINGS]: offline });

    render(<Probe />);
    await settle();

    expectSilent();
  });

  it("stays silent when the detected write 500s", async () => {
    route({
      [SETTINGS]: settings(OTHER_ZONE, "DETECTED"),
      [DETECTED]: json(500, { error: "Internal error" }),
    });

    render(<Probe />);
    await settle();

    // The stored zone simply stays as it is and the next sign-in tries again:
    // Settings is where a wrong zone gets corrected, not here.
    expect(callsTo(DETECTED)).toHaveLength(1);
    expectSilent();
  });

  it("stays silent when the detected write never reaches the server", async () => {
    route({
      [SETTINGS]: settings(OTHER_ZONE, "DETECTED"),
      [DETECTED]: offline,
    });

    render(<Probe />);
    await settle();

    expectSilent();
  });

  it("stays silent when the server refuses the detected zone", async () => {
    route({
      [SETTINGS]: settings(OTHER_ZONE, "DETECTED"),
      [DETECTED]: json(400, {
        error: "Validation failed",
        fields: { timezone: "Unknown IANA time zone" },
      }),
    });

    render(<Probe />);
    await settle();

    expectSilent();
  });

  it("does not retry on a re-render", async () => {
    route({
      [SETTINGS]: settings(OTHER_ZONE, "DETECTED"),
      [DETECTED]: noContent,
    });

    const view = render(<Probe />);
    await settle();
    view.rerender(<Probe />);
    await settle();

    expect(callsTo(SETTINGS)).toHaveLength(1);
    expect(callsTo(DETECTED)).toHaveLength(1);
  });
});
