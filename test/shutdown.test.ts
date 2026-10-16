import { describe, expect, it, vi } from "vitest";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import { NativeSessionHost, type Session } from "../src/core/sessions.js";
import { TerminalLease } from "../src/core/terminal.js";

function record(host: NativeSessionHost, id: string, activity: Session["activity"]): { dispose: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn(async () => {});
  const abort = vi.fn(async () => {});
  const view = activity === "inactive" || activity === "stopped" ? undefined : {
    ui: { stop: vi.fn(), requestRender: vi.fn() } as unknown as TUI,
    lease: new TerminalLease({} as Terminal),
    start: vi.fn(async () => {}),
    dispose,
  };
  host.sessions.set(id, {
    id, cwd: "/tmp", name: id, activity, running: activity === "running", prompts: activity === "waiting" ? 1 : 0,
    unread: false, lastError: activity === "failed" ? "earlier failure" : undefined, view,
    runtime: view ? { session: { abort } } as unknown as Session["runtime"] : undefined,
    mode: view ? { stop: vi.fn() } as unknown as Session["mode"] : undefined,
    removeInput: view ? vi.fn() : undefined,
    context: view ? { ui: { getEditorText: () => `draft-${id}`, setStatus: () => {} } } as unknown as Session["context"] : undefined,
  });
  return { dispose, abort };
}

describe("host shutdown versus explicit stop", () => {
  it("records an interrupted run even when abort settles it before disposal", async () => {
    const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal));
    const busy = record(host, "busy", "running");
    busy.abort.mockImplementation(async () => host.event(host.sessions.get("busy")!, "settled"));
    await host.close();
    expect(host.sessions.get("busy")!.activity).toBe("stopped");
    expect(host.sessions.get("busy")!.running).toBe(false);
  });
  it("keeps settled sessions restorable and records only aborted runs as stopped", async () => {
    const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal));
    const settled = record(host, "settled", "ready");
    const busy = record(host, "busy", "running");
    const broken = record(host, "broken", "failed");
    record(host, "idle", "inactive");
    record(host, "killed", "stopped");

    await host.close();

    // A host shutdown must not relabel a settled session as an explicit stop: the next
    // host start recreates it live from its own managed history.
    expect(host.sessions.get("settled")!.activity).toBe("ready");
    expect(host.sessions.get("settled")!.draft).toBe("draft-settled");
    expect(host.sessions.get("busy")!.activity).toBe("stopped");
    expect(host.sessions.get("broken")!.activity).toBe("failed");
    expect(host.sessions.get("broken")!.lastError).toBe("earlier failure");
    expect(host.sessions.get("idle")!.activity).toBe("inactive");
    expect(host.sessions.get("killed")!.activity).toBe("stopped");
    expect(settled.abort).toHaveBeenCalledOnce();
    expect(busy.abort).toHaveBeenCalledOnce();
    expect(broken.dispose).toHaveBeenCalledOnce();
  });

  it("still records an explicit session stop as stopped", async () => {
    const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal));
    host.activeId = "home";
    record(host, "home", "ready");
    const chosen = record(host, "chosen", "ready");

    await host.stop("chosen");

    expect(host.sessions.get("chosen")!.activity).toBe("stopped");
    expect(chosen.abort).toHaveBeenCalledOnce();
    expect(host.sessions.get("home")!.activity).toBe("ready");
    await host.close();
    expect(host.sessions.get("chosen")!.activity).toBe("stopped");
  });

  it("releases disposed native references after an explicit stop and never re-disposes them on close", async () => {
    const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal));
    host.activeId = "home";
    record(host, "home", "ready");
    const chosen = record(host, "chosen", "ready");
    const row = host.sessions.get("chosen")!;
    row.sessionFile = "/tmp/agent/sessions/chosen.jsonl";
    row.sourceFile = "/tmp/pi/sessions/foreign.jsonl";
    const removeInput = row.removeInput!;

    await host.stop("chosen");

    expect(row.activity).toBe("stopped");
    expect(row.view).toBeUndefined();
    expect(row.runtime).toBeUndefined();
    expect(row.mode).toBeUndefined();
    expect(row.context).toBeUndefined();
    expect(row.removeInput).toBeUndefined();
    expect(removeInput).toHaveBeenCalledOnce();
    expect(chosen.dispose).toHaveBeenCalledOnce();
    expect(chosen.abort).toHaveBeenCalledOnce();
    // Recovery state survives the released runtime.
    expect(row.draft).toBe("draft-chosen");
    expect(row.sessionFile).toBe("/tmp/agent/sessions/chosen.jsonl");
    expect(row.sourceFile).toBe("/tmp/pi/sessions/foreign.jsonl");

    // host.close() must not touch or re-dispose the released session.
    await host.close();
    expect(chosen.dispose).toHaveBeenCalledOnce();
    expect(chosen.abort).toHaveBeenCalledOnce();
    expect(removeInput).toHaveBeenCalledOnce();
    expect(host.sessions.get("chosen")!.activity).toBe("stopped");
  });

  it("keeps native references live when stop fails so shutdown can still dispose them", async () => {
    const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal));
    host.activeId = "home";
    record(host, "home", "ready");
    const broken = record(host, "broken", "ready");
    const row = host.sessions.get("broken")!;
    broken.dispose.mockRejectedValueOnce(new Error("dispose failed"));

    await expect(host.stop("broken")).rejects.toThrow("dispose failed");

    expect(row.activity).toBe("failed");
    expect(row.lastError).toBe("dispose failed");
    expect(row.view).toBeDefined();
    expect(row.runtime).toBeDefined();
    expect(row.mode).toBeDefined();
    expect(row.context).toBeDefined();
    expect(row.removeInput).toBeDefined();
    expect(row.draft).toBe("draft-broken");

    // The live view is still owned by the session, so shutdown disposes it once.
    await host.close();
    expect(broken.dispose).toHaveBeenCalledTimes(2);
    expect(host.sessions.get("broken")!.activity).toBe("failed");
  });
});
