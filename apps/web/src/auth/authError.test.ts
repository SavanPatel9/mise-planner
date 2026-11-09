import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stripAuthErrorParam, takeAuthError } from "./authError";

/** Every test starts from a clean address bar, and leaves one behind. */
function resetUrl(): void {
  window.history.replaceState(null, "", "/");
}

beforeEach(resetUrl);
afterEach(resetUrl);

describe("takeAuthError", () => {
  it("returns the flag the API redirected with and strips it", () => {
    window.history.replaceState(null, "", "/?authError=not_allowed");

    expect(takeAuthError()).toBe("not_allowed");
    expect(window.location.search).toBe("");
  });

  it("recognises the generic failure flag", () => {
    window.history.replaceState(null, "", "/?authError=failed");

    expect(takeAuthError()).toBe("failed");
  });

  it("rejects a value the API never sends, but still strips it", () => {
    window.history.replaceState(null, "", "/?authError=<script>");

    expect(takeAuthError()).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("rejects an empty flag", () => {
    window.history.replaceState(null, "", "/?authError=");

    expect(takeAuthError()).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("returns null and leaves the URL alone when no flag is present", () => {
    window.history.replaceState(null, "", "/?view=today#plan");
    const before = window.location.href;

    expect(takeAuthError()).toBeNull();
    expect(window.location.href).toBe(before);
  });

  it("is single-use: a second read finds nothing", () => {
    window.history.replaceState(null, "", "/?authError=not_allowed");

    expect(takeAuthError()).toBe("not_allowed");
    expect(takeAuthError()).toBeNull();
  });

  it("reads the first of repeated flags and strips every copy", () => {
    window.history.replaceState(
      null,
      "",
      "/?authError=failed&authError=not_allowed",
    );

    expect(takeAuthError()).toBe("failed");
    expect(window.location.search).toBe("");
  });
});

describe("stripAuthErrorParam", () => {
  it("keeps the path, the other params, and the hash", () => {
    window.history.replaceState(
      null,
      "",
      "/plan?view=today&authError=failed&tz=utc#block-2",
    );

    stripAuthErrorParam();

    expect(window.location.pathname).toBe("/plan");
    expect(window.location.search).toBe("?view=today&tz=utc");
    expect(window.location.hash).toBe("#block-2");
  });

  it("is idempotent", () => {
    window.history.replaceState(null, "", "/?authError=not_allowed&view=today");

    stripAuthErrorParam();
    const once = window.location.href;
    stripAuthErrorParam();

    expect(window.location.href).toBe(once);
  });

  it("replaces rather than pushes, so Back does not return to the flag", () => {
    window.history.replaceState(null, "", "/?authError=failed");
    const entries = window.history.length;

    stripAuthErrorParam();

    expect(window.history.length).toBe(entries);
  });

  it("preserves the current history state", () => {
    window.history.replaceState({ scroll: 120 }, "", "/?authError=failed");

    stripAuthErrorParam();

    expect(window.history.state).toEqual({ scroll: 120 });
  });
});
