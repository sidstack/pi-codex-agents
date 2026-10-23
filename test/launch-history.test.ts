import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { launchedHistory } from "../src/pi/launch-history.js";

function context(options: { entries?: boolean; file?: string | null; id?: string | null } = {}): ExtensionContext {
  // `null` means the launched Pi reports no file or id at all, as an in-memory session does.
  const file = options.file === null ? undefined : (options.file ?? "/home/me/.pi/agent/sessions/--proj--/01ABC.jsonl");
  const id = options.id === null ? undefined : (options.id ?? "01ABC");
  return {
    sessionManager: {
      getLeafEntry: vi.fn(() => (options.entries ? { id: "an-entry" } : undefined)),
      getSessionFile: vi.fn(() => file),
      getSessionId: vi.fn(() => id),
    },
  } as unknown as ExtensionContext;
}

describe("the history a Pi launch already opened", () => {
  it.each([
    [["pi", "--session", "01ABC"]],
    [["pi", "--session-id", "01ABC"]],
    [["pi", "--continue"]],
    [["pi", "-c"]],
    [["pi", "--resume"]],
    [["pi", "-r"]],
    [["pi", "--fork", "01ABC"]],
    [["pi", "--model", "opus", "-c", "--thinking", "high"]],
  ])("names the history for %j", (argv) => {
    expect(launchedHistory(context(), ["node", ...argv])).toEqual({ sessionFile: "/home/me/.pi/agent/sessions/--proj--/01ABC.jsonl", sessionId: "01ABC" });
  });

  it("names the history a resumed launch holds without a recognizable flag", () => {
    expect(launchedHistory(context({ entries: true }), ["node", "pi"])?.sessionFile).toBe("/home/me/.pi/agent/sessions/--proj--/01ABC.jsonl");
  });

  it("leaves a fresh launch with a fresh history to the directory", () => {
    expect(launchedHistory(context(), ["node", "pi"])).toBeUndefined();
    expect(launchedHistory(context(), ["node", "pi", "--no-session"])).toBeUndefined();
    expect(launchedHistory(context(), ["node", "pi", "--name", "-c"])).toBeUndefined();
  });

  it("ignores flags after the argument separator", () => {
    expect(launchedHistory(context(), ["node", "pi", "--", "-c"])).toBeUndefined();
  });

  it("leaves an in-memory launch with no history to name", () => {
    expect(launchedHistory(context({ file: null }), ["node", "pi", "-c"])).toBeUndefined();
  });

  it("omits an id the launched Pi did not report", () => {
    expect(launchedHistory(context({ id: null }), ["node", "pi", "-c"])).toEqual({ sessionFile: "/home/me/.pi/agent/sessions/--proj--/01ABC.jsonl" });
  });
});
