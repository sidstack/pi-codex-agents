import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Terminal } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../src/config.js";
import { NativeSessionHost, type Session } from "../src/core/sessions.js";
import { createDelegationFeature } from "../src/features/delegation.js";
import { DelegationStore } from "../src/features/delegation-store.js";
import { supportedPiVersion } from "../src/pi-version.js";

const roots: string[] = [];
const original = process.env.PI_AGENTS_NATIVE_DIR;
afterEach(async () => { if (original === undefined) delete process.env.PI_AGENTS_NATIVE_DIR; else process.env.PI_AGENTS_NATIVE_DIR = original; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), "pi-delegation-")); roots.push(path); return path; }
function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const path = await root(); process.env.PI_AGENTS_NATIVE_DIR = join(path, "host");
  const feature = createDelegationFeature();
  const host = new NativeSessionHost(path, () => ({} as Terminal), DEFAULT_CONFIG, [feature]);
  const finishes = new Map<string, () => void>();
  vi.spyOn(host, "create").mockImplementation(async (cwd, _trusted, _parent, options = {}) => {
    const done = gate(); finishes.set(options.id!, done.resolve);
    const row: Session = { id: options.id!, name: options.name!, cwd, activity: "ready", running: false, prompts: 0, unread: false };
    row.runtime = { session: { model: { id: "fake", provider: "fake" }, modelRuntime: { getModel: () => ({ id: "fake", provider: "fake" }) },
      setModel: vi.fn(async () => {}), setThinkingLevel: vi.fn(), setSessionName: vi.fn(), isIdle: true,
      messages: [{ role: "assistant", content: [{ type: "text", text: "Verified worker result" }] }],
      prompt: vi.fn(async () => { row.running = true; await done.promise; row.running = false; }),
      steer: vi.fn(async () => {}), abort: vi.fn(async () => done.resolve()),
    } } as unknown as Session["runtime"];
    row.view = { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}), lease: { enabled: false }, ui: { stop: vi.fn() } } as unknown as Session["view"];
    host.sessions.set(row.id, row); return row;
  });
  host.startFeatures();
  const request = (operation: string, input: Record<string, unknown> = {}, caller = "controller:test") => host.featureRequest(`agents.${operation}`, input, caller) as Promise<Record<string, any>>;
  return { path, host, request, finishes };
}

describe("native delegation and mail", () => {
  it("reserves capacity atomically, names native workers, uses medium, and never changes activeId", async () => {
    const f = await fixture();
    const input = { name: "Review files", cwd: f.path, task: "Review one file", role: "review" };
    const [a, b] = await Promise.all([f.request("spawn", input), f.request("spawn", input)]);
    await expect(f.request("spawn", input)).rejects.toThrow("capacity 2");
    expect(f.host.activeId).toBe("home");
    expect(f.host.sessions.size).toBe(2);
    expect(f.host.sessions.get(a.id)!.runtime!.session.setThinkingLevel).toHaveBeenCalledWith("medium");
    expect(f.host.sessions.get(a.id)!.runtime!.session.setSessionName).toHaveBeenCalledWith("Review files");
    await expect(f.request("spawn", input, a.id)).rejects.toThrow("Workers cannot spawn");
    f.finishes.get(a.id)!(); f.finishes.get(b.id)!();
    await f.host.close();
  });
  it("delivers worker questions and supervisor replies without a transcript read or extra run", async () => {
    const f = await fixture();
    const worker = await f.request("spawn", { name: "Test messages", cwd: f.path, task: "Test mailbox" });
    await f.request("send", { to: "parent", kind: "question", text: "Which file?" }, worker.id);
    const parent = await f.request("inbox");
    expect(parent.messages[0]).toMatchObject({ from: worker.id, text: "Which file?", to: "controller:test" });
    const pending = f.request("wait", { timeoutMs: 1000 }, worker.id);
    await f.request("send", { to: worker.id, text: "Only assigned.ts" });
    expect((await pending).messages[0].text).toBe("Only assigned.ts");
    const row = f.host.sessions.get(worker.id)!;
    expect(row.runtime!.session.prompt).toHaveBeenCalledTimes(1);
    await expect(f.request("send", { to: worker.id, text: "No", wake: true }, worker.id)).rejects.toThrow("Workers send mailbox");
    await expect(f.request("send", { to: worker.id, text: "No" }, "controller:other")).rejects.toThrow("outside");
    await f.request("stop", { sessionId: worker.id });
    expect(row.activity).toBe("stopped");
    await f.host.close();
  });
  it("stops a worker during preparation without starting its task or disposing twice", async () => {
    const f = await fixture();
    const originalCreate = vi.mocked(f.host.create).getMockImplementation()!;
    const pending = gate();
    vi.mocked(f.host.create).mockImplementationOnce(async (...args) => { await pending.promise; return originalCreate(...args); });
    const spawn = f.request("spawn", { name: "Preparing", cwd: f.path, task: "Must not run" });
    const id = (await f.request("list")).workers[0].id;
    const stop = f.request("stop", { sessionId: id });
    const rejected = expect(spawn).rejects.toThrow("stopped while preparing");
    pending.resolve(); await rejected; await stop;
    const row = f.host.sessions.get(id)!;
    expect(row.runtime).toBeUndefined();
    expect((await f.request("list")).workers[0].state).toBe("stopped");
    await f.host.close();
  });

  it("preserves bounded durable mail and reports truncation rather than replaying work", async () => {
    const path = await root(); const file = join(path, "mail.json");
    const store = new DelegationStore(file);
    store.workers.set("worker", { id: "worker", parent: "controller:test", name: "Task", cwd: path, role: "test", state: "running", createdAt: "now" });
    await writeFile(file, JSON.stringify({ version: 1, sequence: 256, workers: [...store.workers.values()], messages: Array.from({ length: 256 }, (_, i) => ({ id: i + 1, from: "worker", to: "controller:test", kind: "progress", text: `${i}`, createdAt: "now" })) }), { mode: 0o600 });
    const populated = new DelegationStore(file);
    for (let i = 0; i < 4; i++) populated.send("worker", "controller:test", "progress", `${i}`);
    const restored = new DelegationStore(file);
    expect(restored.workers.get("worker")!.state).toBe("failed");
    expect(restored.inbox("controller:test", 1)).toMatchObject({ truncated: true });
    expect(restored.inbox("controller:test", 1).messages).toHaveLength(20);
    const waiting = restored.wait("nobody", 0, 25000);
    restored.close(); await expect(waiting).resolves.toMatchObject({ messages: [] });
  });
  it("keeps disabled delegation unavailable and validates requests before allocating sessions", async () => {
    const path = await root(); await mkdir(join(path, "agent"));
    const host = new NativeSessionHost(path, () => ({} as Terminal), DEFAULT_CONFIG, []);
    await expect(host.featureRequest("agents.spawn", {}, "controller:test")).rejects.toThrow("unavailable");
    const f = await fixture();
    await expect(f.request("spawn", { name: "Invalid", cwd: "relative", task: "x" })).rejects.toThrow("absolute");
    expect(f.host.sessions.size).toBe(0); await f.host.close(); await host.close();
  });
});

describe("Pi adapter version range", () => {
  it.each([["1.3.0", true], ["1.3.27", true], ["1.2.9", false], ["1.4.0", false], ["2.0.0", false], ["1.3.1-beta.1", false]])("%s support is %s", (version, supported) => { expect(supportedPiVersion(version)).toBe(supported); });
});
