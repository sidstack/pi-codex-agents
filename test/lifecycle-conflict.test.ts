import { describe, expect, it, vi } from "vitest";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import { NativeSessionHost, type Session } from "../src/core/sessions.js";
import { TerminalLease } from "../src/core/terminal.js";

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Home plus two idle sessions whose native disposal is held behind a gate. */
function fixture(): {
  host: NativeSessionHost;
  idle1: Session; idle2: Session;
  dispose1: ReturnType<typeof vi.fn>; dispose2: ReturnType<typeof vi.fn>;
  finish1: () => void; finish2: () => void;
} {
  const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal));
  host.activeId = "home";
  const first = gate();
  const second = gate();
  const disposals: Record<string, ReturnType<typeof vi.fn>> = {};
  const add = (id: string, dispose: () => Promise<void>) => {
    const lease = new TerminalLease({ write: vi.fn(), start: vi.fn(), stop: vi.fn(), setProgress: vi.fn(), columns: 80 } as unknown as Terminal);
    const disposeMock = vi.fn(dispose);
    disposals[id] = disposeMock;
    host.sessions.set(id, {
      id, cwd: `/tmp/${id}`, name: id, activity: "ready", running: false, prompts: 0, unread: false,
      lastActivityAt: 100, sessionFile: `/tmp/agent/sessions/${id}.jsonl`,
      view: { ui: { terminal: lease.terminal, stop: vi.fn(), requestRender: vi.fn() } as unknown as TUI, lease, start: vi.fn(async () => {}), dispose: disposeMock },
      runtime: { session: { isIdle: true, abort: vi.fn(async () => {}) } } as unknown as Session["runtime"],
      context: { ui: { getEditorText: () => `draft-${id}`, setStatus: () => {} } } as unknown as Session["context"],
    });
  };
  add("home", async () => {});
  add("idle1", () => first.promise);
  add("idle2", () => second.promise);
  host.sessions.get("home")!.view!.lease.enabled = true;
  return {
    host,
    idle1: host.sessions.get("idle1")!, idle2: host.sessions.get("idle2")!,
    dispose1: disposals.idle1!, dispose2: disposals.idle2!,
    finish1: first.resolve, finish2: second.resolve,
  };
}

describe("close() racing an in-flight inactivity unload", () => {
  it("disposes each native view exactly once when shutdown starts mid-unload", async () => {
    const { host, idle1, idle2, dispose1, dispose2, finish1, finish2 } = fixture();

    // The unload loop is parked on idle1's pending disposal.
    const unload = host.deactivateIdle(2000, 1000);
    expect(idle1.stopping).toBe(true);
    expect(idle2.stopping).toBeUndefined();

    // Shutdown begins while the unload loop is still running: it waits for the unload
    // tasks it can see now, but not for the one the loop starts afterwards.
    const shutdown = host.close();
    finish1();
    await new Promise((resolve) => setImmediate(resolve));

    expect(dispose1).toHaveBeenCalledOnce();
    // The unload loop stops at shutdown; shutdown alone now owns idle2.
    expect(dispose2.mock.calls.length).toBe(1);

    finish2();
    await Promise.all([unload, shutdown]);
    expect(idle2.view).toBeUndefined();
  });
});
