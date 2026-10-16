import { describe, expect, it, vi } from "vitest";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import { NativeSessionHost, type Session } from "../src/core/sessions.js";
import { TerminalLease } from "../src/core/terminal.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(): {
  host: NativeSessionHost;
  home: Session; idle: Session; live: Session;
  homeStop: ReturnType<typeof vi.fn>; idleStop: ReturnType<typeof vi.fn>; idleDispose: ReturnType<typeof vi.fn>;
  finishUnload: () => void;
} {
  const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal));
  host.activeId = "home";
  const gate = deferred();
  const rows: Record<string, { stop: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = {};
  const add = (id: string, activityAt: number, dispose: () => Promise<void>) => {
    const lease = new TerminalLease({ write: vi.fn(), start: vi.fn(), stop: vi.fn(), setProgress: vi.fn(), columns: 80 } as unknown as Terminal);
    const stop = vi.fn();
    const disposeMock = vi.fn(dispose);
    rows[id] = { stop, dispose: disposeMock };
    host.sessions.set(id, {
      id, cwd: `/tmp/${id}`, name: id, activity: "ready", running: false, prompts: 0, unread: false,
      lastActivityAt: activityAt, sessionFile: `/tmp/agent/sessions/${id}.jsonl`,
      view: { ui: { terminal: lease.terminal, stop, requestRender: vi.fn() } as unknown as TUI, lease, start: vi.fn(async () => {}), dispose: disposeMock },
      runtime: { session: { isIdle: true, abort: vi.fn(async () => {}) } } as unknown as Session["runtime"],
      context: { ui: { getEditorText: () => `draft-${id}`, setStatus: () => {} } } as unknown as Session["context"],
    });
  };
  add("home", 100, async () => {});
  add("idle", 100, () => gate.promise);
  add("live", 1900, async () => {});
  host.sessions.get("home")!.view!.lease.enabled = true;
  return {
    host,
    home: host.sessions.get("home")!, idle: host.sessions.get("idle")!, live: host.sessions.get("live")!,
    homeStop: rows.home!.stop, idleStop: rows.idle!.stop, idleDispose: rows.idle!.dispose,
    finishUnload: gate.resolve,
  };
}

describe("navigation while a session unloads", () => {
  it("refuses a direct activation of a session whose view is still being disposed", async () => {
    const { host, home, idle, homeStop, idleStop, finishUnload } = fixture();
    const unload = host.deactivateIdle(2000, 1000);
    expect(idle).toMatchObject({ activity: "inactive", stopping: true });
    expect(idle.view).toBeDefined(); // disposal is still pending behind the gate

    await expect(host.activate("idle")).rejects.toThrow("Session unavailable");

    // The handoff was rejected before it touched either terminal.
    expect(host.activeId).toBe("home");
    expect(home.view).toBeDefined();
    expect(home.view!.lease.enabled).toBe(true);
    expect(homeStop).not.toHaveBeenCalled();
    expect(idleStop).not.toHaveBeenCalled();
    expect(idle.view!.lease.enabled).toBe(false);

    finishUnload();
    await unload;
    expect(idle.view).toBeUndefined();
    expect(host.activeId).toBe("home");
    expect(home.view).toBeDefined();
    expect(home.view!.lease.enabled).toBe(true);

    // Home navigation stays usable after the unload finished.
    await host.activate("live");
    expect(host.activeId).toBe("live");
    await host.activate("home");
    expect(host.activeId).toBe("home");
    expect(home.view!.lease.enabled).toBe(true);
  });

  it("cycles past an unloading session and keeps Home usable when disposal finishes", async () => {
    const { host, home, idle, live, finishUnload } = fixture();
    const unload = host.deactivateIdle(2000, 1000);

    await host.cycle(1);
    expect(host.activeId).toBe("live");
    expect(live.view!.lease.enabled).toBe(true);
    expect(home.view!.lease.enabled).toBe(false);
    expect(idle.view!.lease.enabled).toBe(false);

    finishUnload();
    await unload;
    expect(idle.view).toBeUndefined();

    await host.cycle(1);
    expect(host.activeId).toBe("home");
    expect(home.view).toBeDefined();
    expect(home.view!.lease.enabled).toBe(true);
  });

  it("does not hand the terminal away when the only other session is unloading", async () => {
    const { host, home, idle, homeStop, finishUnload } = fixture();
    host.sessions.delete("live");
    const unload = host.deactivateIdle(2000, 1000);

    await host.cycle(1);
    await host.cycle(-1);
    expect(host.activeId).toBe("home");
    expect(home.view).toBeDefined();
    expect(home.view!.lease.enabled).toBe(true);
    expect(homeStop).not.toHaveBeenCalled();

    finishUnload();
    await unload;
    expect(idle.view).toBeUndefined();
    expect(host.activeId).toBe("home");
    expect(home.view!.lease.enabled).toBe(true);
  });

  it("never unloads a session whose explicit stop is already in progress", async () => {
    const { host, idle, idleDispose, finishUnload } = fixture();
    const stopping = host.stop("idle");
    await new Promise((resolve) => setImmediate(resolve)); // let stop() reach its own disposal
    expect(idle.stopping).toBe(true);

    const unload = host.deactivateIdle(2000, 1000);
    finishUnload();
    await Promise.all([stopping, unload]);

    expect(idleDispose).toHaveBeenCalledOnce();
    expect(host.sessions.get("idle")!.activity).toBe("stopped");
    expect(host.activeId).toBe("home");
    expect(host.sessions.get("home")!.view!.lease.enabled).toBe(true);
  });
});

describe("conflicting native transitions", () => {
  it("shares simultaneous stops and lets host close await the one disposal", async () => {
    const { host, idle, idleDispose, finishUnload } = fixture();
    const first = host.stop(idle.id);
    const second = host.stop(idle.id);
    expect(first).toBe(second);
    await new Promise((done) => setImmediate(done));
    expect(idleDispose).toHaveBeenCalledOnce();
    let closed = false;
    const closing = host.close().then(() => { closed = true; });
    await new Promise((done) => setImmediate(done));
    expect(closed).toBe(false);
    finishUnload();
    await Promise.all([first, second, closing]);
    expect(idleDispose).toHaveBeenCalledOnce();
    expect(idle.runtime).toBeUndefined();
  });

  it("keeps the departing view available for rollback during slow initialization", async () => {
    const { host, idle, live } = fixture();
    await host.activate(idle.id);
    idle.lastActivityAt = 100;
    const barrier = deferred();
    vi.mocked(live.view!.start).mockImplementationOnce(async () => { await barrier.promise; throw new Error("init failed"); });
    const navigation = host.activate(live.id);
    await new Promise((done) => setImmediate(done));
    expect(host.activeId).toBe(live.id);
    await host.deactivateIdle(2000, 1000);
    expect(idle.view).toBeDefined();
    const rejection = expect(navigation).rejects.toThrow("init failed");
    barrier.resolve(); await rejection;
    expect(host.activeId).toBe(idle.id);
    expect(idle.view!.lease.enabled).toBe(true);
  });

  it.each(["stop", "close"] as const)("%s cancels a dialog before awaiting its initializing handoff", async (operation) => {
    const { host, live, finishUnload } = fixture();
    const prompt = deferred();
    const cancel = vi.fn(() => { prompt.resolve(); return () => {}; });
    live.view!.cancelPrompts = cancel;
    vi.mocked(live.view!.start).mockImplementationOnce(() => prompt.promise);
    const navigation = host.activate(live.id);
    await new Promise((done) => setImmediate(done));
    finishUnload();
    const transition = operation === "stop" ? host.stop(live.id) : host.close();
    await Promise.all([navigation, transition]);
    expect(cancel).toHaveBeenCalled();
    expect(live.runtime).toBeUndefined();
    if (operation === "stop") expect(host.activeId).toBe("home");
  });

  it("refuses queued navigation after host close begins", async () => {
    const { host, live, finishUnload } = fixture();
    const closing = host.close();
    await expect(host.activate(live.id)).rejects.toThrow("closing");
    finishUnload(); await closing;
    expect(host.sessions.get(host.activeId)?.view).toBeUndefined();
  });
});
