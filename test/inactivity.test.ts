import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@earendil-works/pi-tui";
import { loadConfig } from "../src/config.js";
import { NativeSessionHost, type Session } from "../src/core/sessions.js";

function fixture(activity: Session["activity"] = "ready"): { host: NativeSessionHost; row: Session; dispose: ReturnType<typeof vi.fn> } {
  const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal));
  host.activeId = "home";
  const dispose = vi.fn(async () => {});
  const row: Session = {
    id: "child", cwd: "/tmp", name: "Child", activity, running: activity === "running", prompts: activity === "waiting" ? 1 : 0,
    unread: false, lastActivityAt: 100,
    view: { dispose } as unknown as Session["view"],
    context: { ui: { getEditorText: () => "unfinished draft", setStatus: () => {} } } as unknown as Session["context"],
  };
  host.sessions.set(row.id, row);
  return { host, row, dispose };
}

describe("automatic session inactivity", () => {
  it("unloads a hidden settled view and retains its draft for restoration", async () => {
    const { host, row, dispose } = fixture();
    await host.deactivateIdle(2000, 1000);
    expect(dispose).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ activity: "inactive", draft: "unfinished draft" });
    expect(row.view).toBeUndefined();
    expect(row.context).toBeUndefined();
  });

  it.each(["running", "waiting", "failed", "stopped"] as const)("never unloads a %s session", async (activity) => {
    const { host, dispose } = fixture(activity);
    await host.deactivateIdle(2000, 1000);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("keeps the foreground, Home, and recently used sessions loaded", async () => {
    const { host, row, dispose } = fixture();
    host.activeId = row.id;
    await host.deactivateIdle(2000, 1000);
    host.activeId = "home";
    await host.deactivateIdle(500, 1000);
    await host.deactivateIdle(2000, 0);
    row.id = "home";
    host.activeId = "other";
    await host.deactivateIdle(2000, 1000);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("reports disposal failures instead of calling them inactive", async () => {
    const { host, row, dispose } = fixture();
    dispose.mockRejectedValue(new Error("disposal failed"));
    await host.deactivateIdle(2000, 1000);
    expect(row).toMatchObject({ activity: "failed", lastError: "disposal failed" });
  });

  it("validates the configured idle timeout", () => {
    const before = process.env.PI_AGENTS_IDLE_MS;
    try {
      process.env.PI_AGENTS_IDLE_MS = "0";
      expect(loadConfig().idleTimeoutMs).toBe(0);
      process.env.PI_AGENTS_IDLE_MS = "bad";
      expect(() => loadConfig().idleTimeoutMs).toThrow("PI_AGENTS_IDLE_MS");
    } finally {
      if (before === undefined) delete process.env.PI_AGENTS_IDLE_MS;
      else process.env.PI_AGENTS_IDLE_MS = before;
    }
  });
});
