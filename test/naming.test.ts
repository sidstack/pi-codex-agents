import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";
import { NativeSessionHost, type Session } from "../src/core/sessions.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createNamingFeature, type NameGenerator } from "../src/features/naming.js";

function fixture(generate: NameGenerator = vi.fn(async () => '"Repair native session recovery"')) {
  const feature = createNamingFeature(generate);
  const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal), DEFAULT_CONFIG, [feature]);
  let manual: string | undefined;
  const setSessionName = vi.fn((name: string) => { manual = name; });
  const ctx = { sessionManager: { getSessionName: () => manual, getBranch: () => [
    { type: "message", message: { role: "user", content: "fix recovery" } },
  ] }, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
  const record: Session = { id: "task", name: "directory", cwd: "/tmp", activity: "ready", running: false, prompts: 0, unread: false,
    runtime: { session: { setSessionName } } as unknown as AgentSessionRuntime };
  host.sessions.set(record.id, record);
  host.startFeatures();
  return { feature, host, ctx, record, generate, setSessionName, manual: (name: string) => { manual = name; } };
}
const flush = async () => { await new Promise((done) => setTimeout(done, 0)); };

describe("optional first-message naming", () => {
  it("names once after settling without creating agent turns", async () => {
    const f = fixture();
    f.host.settled(f.record, f.ctx);
    await flush();
    expect(f.generate).toHaveBeenCalledWith(f.ctx, "fix recovery", expect.any(AbortSignal));
    expect(f.setSessionName).toHaveBeenCalledWith("Repair native session recovery");
    expect(f.record.name).toBe("Repair native session recovery");
    f.host.settled(f.record, f.ctx);
    expect(f.generate).toHaveBeenCalledOnce();
  });
  it("does not name on restoration, Home, or manually named sessions", async () => {
    const f = fixture();
    f.host.onChange();
    expect(f.generate).not.toHaveBeenCalled();
    f.record.id = "home";
    f.host.settled(f.record, f.ctx);
    f.record.id = "task";
    f.manual("My title");
    f.host.settled(f.record, f.ctx);
    await flush();
    expect(f.generate).not.toHaveBeenCalled();
  });
  it("preserves manual naming while the metadata request is pending", async () => {
    let resolve!: (name: string) => void;
    const f = fixture(vi.fn(() => new Promise<string>((done) => { resolve = done; })));
    f.host.settled(f.record, f.ctx);
    f.manual("User chose this");
    resolve("Generated title");
    await flush();
    expect(f.setSessionName).not.toHaveBeenCalled();
  });
  it("waits for other runs, cancels on new work, and cleans up on close", async () => {
    let resolve!: (name: string) => void;
    const generate = vi.fn((_ctx: ExtensionContext, _text: string, _signal: AbortSignal) => new Promise<string>((done) => { resolve = done; }));
    const f = fixture(generate);
    const other = { ...f.record, id: "other", running: true, runtime: undefined };
    f.host.sessions.set(other.id, other);
    f.host.settled(f.record, f.ctx);
    expect(generate).not.toHaveBeenCalled();
    other.running = false; f.host.onChange();
    expect(generate).toHaveBeenCalledOnce();
    other.running = true; f.host.onChange();
    expect(generate.mock.calls[0]![2].aborted).toBe(true);
    // Remove the runtime double before core disposal; this test isolates feature cleanup.
    f.record.runtime = undefined; other.running = false;
    await f.host.close();
    resolve("Late title"); await flush();
    expect(f.setSessionName).not.toHaveBeenCalled();
  });
});
