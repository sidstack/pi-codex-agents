import { describe, expect, it, vi } from "vitest";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import { NativeFleet, type LiveSession, type NativeView } from "../src/core/fleet.js";
import { TerminalLease } from "../src/core/terminal.js";

function view(fail = false): NativeView {
  const source = { write: vi.fn(), start: vi.fn(), stop: vi.fn(), setTitle: vi.fn(), setProgress: vi.fn(), drainInput: vi.fn(), columns: 80 };
  const lease = new TerminalLease(source as unknown as Terminal);
  const ui = { terminal: lease.terminal, stop: vi.fn(), requestRender: vi.fn() } as unknown as TUI;
  return { ui, lease, start: vi.fn(async () => { if (fail) throw new Error("startup failed"); }), dispose: vi.fn(async () => {}) };
}
function record(id: string, v = view()): LiveSession {
  return { id, name: id, cwd: `/tmp/${id}`, activity: "ready", running: false, prompts: 0, unread: false, view: v };
}

describe("native session ownership", () => {
  it("switches terminal ownership without disposing or ending background runs", async () => {
    const fleet = new NativeFleet();
    const home = record("home"), child = record("child");
    fleet.sessions.set(home.id, home); fleet.sessions.set(child.id, child);
    home.view!.lease.enabled = true;
    fleet.event(home, "start");
    await fleet.activate(child.id);
    expect(home.running).toBe(true);
    expect(home.view!.lease.enabled).toBe(false);
    expect(home.view!.dispose).not.toHaveBeenCalled();
    fleet.event(home, "settled");
    expect(home.unread).toBe(true);
    await fleet.activate(home.id);
    expect(home.unread).toBe(false);
    expect(child.view!.lease.enabled).toBe(false);
  });

  it("restores the previous view and reports failed when initialization throws", async () => {
    const fleet = new NativeFleet();
    const home = record("home"), bad = record("bad", view(true));
    fleet.sessions.set(home.id, home); fleet.sessions.set(bad.id, bad);
    home.view!.lease.enabled = true;
    await expect(fleet.activate("bad")).rejects.toThrow("startup failed");
    expect(fleet.activeId).toBe("home");
    expect(home.view!.lease.enabled).toBe(true);
    expect(bad.view!.lease.enabled).toBe(false);
    expect(bad).toMatchObject({ activity: "failed", lastError: "startup failed" });
    await fleet.activate("home"); // A failure must not poison later navigation.
  });

  it("serializes rapid navigation and preserves pending dialogs and errors", async () => {
    const fleet = new NativeFleet();
    const home = record("home"), a = record("a"), b = record("b");
    for (const row of [home, a, b]) fleet.sessions.set(row.id, row);
    await Promise.all([fleet.activate("a"), fleet.activate("b"), fleet.activate("home")]);
    expect([home, a, b].filter((r) => r.view!.lease.enabled).map((r) => r.id)).toEqual(["home"]);
    fleet.event(a, "start"); fleet.event(a, "prompt-start");
    expect(a.activity).toBe("waiting");
    fleet.event(a, "prompt-end");
    expect(a.activity).toBe("running");
    fleet.fail(a, "provider failed"); fleet.event(a, "settled");
    expect(a.activity).toBe("failed");
    expect(a.lastError).toBe("provider failed");
  });

  it("gates input, progress, title, render and terminal control calls", async () => {
    const source = { columns: 100, write: vi.fn(), setTitle: vi.fn(), setProgress: vi.fn(), start: vi.fn(), stop: vi.fn(), drainInput: vi.fn(async () => {}) };
    const lease = new TerminalLease(source as unknown as Terminal);
    lease.terminal.write("hidden"); lease.terminal.setTitle("hidden"); lease.terminal.setProgress(true);
    lease.terminal.start(() => {}, () => {}); lease.terminal.stop(); await lease.terminal.drainInput();
    expect(source.write).not.toHaveBeenCalled(); expect(source.setTitle).not.toHaveBeenCalled();
    expect(source.setProgress).not.toHaveBeenCalled(); expect(source.start).not.toHaveBeenCalled();
    expect(source.stop).not.toHaveBeenCalled(); expect(source.drainInput).not.toHaveBeenCalled();
    expect(lease.terminal.columns).toBe(100);
    lease.enabled = true;
    lease.restore();
    expect(source.setTitle).toHaveBeenCalledWith("hidden");
    expect(source.setProgress).toHaveBeenCalledWith(true);
    lease.terminal.write("visible"); lease.terminal.setTitle("visible");
    expect(source.write).toHaveBeenCalledWith("visible"); expect(source.setTitle).toHaveBeenCalledWith("visible");
  });
});
