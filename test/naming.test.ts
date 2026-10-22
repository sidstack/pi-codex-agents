import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";
import { NativeSessionHost, type Session } from "../src/core/sessions.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createNamingFeature, extractiveName, type NameGenerator } from "../src/features/naming.js";

const FIRST_MESSAGE = "fix the native recovery race in session restore";
const userMessage = { role: "user", content: FIRST_MESSAGE } as unknown as MessageEndEvent["message"];

interface Fixture {
  host: NativeSessionHost;
  record: Session;
  ctx: ExtensionContext;
  generate: ReturnType<typeof vi.fn>;
  setSessionName: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  find: ReturnType<typeof vi.fn>;
  storedName: (name?: string) => string | undefined;
  other: Session;
}

function fixture(options: { generate?: NameGenerator; nameModel?: string; firstMessage?: string; realGenerator?: boolean } = {}): Fixture {
  const generate = vi.fn(options.generate ?? (async () => "Repair native session recovery"));
  const feature = createNamingFeature({
    ...(options.realGenerator ? {} : { generate }),
    ...(options.nameModel === undefined ? {} : { nameModel: options.nameModel }),
  });
  const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal), DEFAULT_CONFIG, [feature]);
  let stored: string | undefined;
  const setSessionName = vi.fn((name: string) => { stored = name; });
  const notify = vi.fn();
  const find = vi.fn(() => undefined);
  const text = options.firstMessage ?? FIRST_MESSAGE;
  const ctx = {
    sessionManager: {
      getSessionName: () => stored,
      getBranch: () => [{ type: "message", message: { role: "user", content: text } } as never],
    },
    model: { id: "session-model" },
    modelRegistry: { find, hasConfiguredAuth: vi.fn(() => false), streamSimple: vi.fn() },
    ui: { notify },
  } as unknown as ExtensionContext;
  const record: Session = { id: "task", name: "directory", cwd: "/tmp/task", activity: "ready", running: false, prompts: 0, unread: false,
    runtime: { session: { setSessionName } } as unknown as AgentSessionRuntime };
  record.context = ctx;
  host.sessions.set(record.id, record);
  host.startFeatures();
  const other: Session = { id: "other", name: "other", cwd: "/tmp/other", activity: "ready", running: false, prompts: 0, unread: false };
  host.sessions.set(other.id, other);
  return { host, record, ctx, generate, setSessionName, notify, find, other, storedName: (name?: string) => { if (name !== undefined) stored = name; return stored; } };
}

const tick = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };

describe("session naming", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("labels the session at the first message without a model request", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.host.messageEnd(f.record, f.ctx, userMessage);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.setSessionName).toHaveBeenCalledWith("fix the native recovery race in session restore");
    expect(f.record.name).toBe("fix the native recovery race in session restore");
  });

  it("refines the label with one bounded model request after the first settled turn", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.host.messageEnd(f.record, f.ctx, userMessage);
    f.host.settled(f.record, f.ctx);
    await tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.generate.mock.calls[0]![1]).toBe(FIRST_MESSAGE);
    expect(f.setSessionName).toHaveBeenLastCalledWith("Repair native session recovery");
    expect(f.record.name).toBe("Repair native session recovery");
    f.host.settled(f.record, f.ctx);
    await tick(60_000);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("titles a long first message immediately instead of waiting for the turn", async () => {
    vi.useFakeTimers();
    const f = fixture({ firstMessage: "x".repeat(2600) });
    f.host.messageEnd(f.record, f.ctx, userMessage);
    await tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.generate.mock.calls[0]![1]).toHaveLength(2000);
  });

  it("titles Home like any other session", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.host.sessions.delete(f.record.id);
    f.record.id = "home";
    f.host.sessions.set(f.record.id, f.record);
    f.host.messageEnd(f.record, f.ctx, userMessage);
    f.host.settled(f.record, f.ctx);
    await tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.setSessionName).toHaveBeenLastCalledWith("Repair native session recovery");
  });

  it("keeps a manual name and stops requesting titles", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.host.messageEnd(f.record, f.ctx, userMessage);
    f.storedName("User chose this");
    f.record.name = "User chose this";
    f.host.settled(f.record, f.ctx);
    await tick(60_000);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.setSessionName).toHaveBeenCalledTimes(1);
  });

  it("does not cancel a title request because another session started working", async () => {
    vi.useFakeTimers();
    let resolve!: (name: string) => void;
    const f = fixture({ generate: () => new Promise<string>((done) => { resolve = done; }) });
    f.host.settled(f.record, f.ctx);
    await tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    f.other.running = true;
    f.host.onChange();
    await tick();
    expect((f.generate.mock.calls[0]![2] as AbortSignal).aborted).toBe(false);
    f.other.running = false;
    resolve("Generated while busy");
    await tick();
    expect(f.setSessionName).toHaveBeenLastCalledWith("Generated while busy");
  });

  it("retries a cancelled request after the session runtime returns", async () => {
    vi.useFakeTimers();
    const f = fixture({ generate: vi.fn(() => new Promise<string>(() => { /* never settles */ })) });
    f.host.settled(f.record, f.ctx);
    await tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    const runtime = f.record.runtime;
    f.record.runtime = undefined;
    f.host.onChange();
    f.record.runtime = runtime;
    f.host.settled(f.record, f.ctx);
    await tick(31_000);
    expect(f.generate.mock.calls[0]![2] as AbortSignal).toBeInstanceOf(AbortSignal);
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it("keeps the extractive label and reports once when attempts are exhausted", async () => {
    vi.useFakeTimers();
    const generate = vi.fn(async () => { throw new Error("provider unavailable"); });
    const f = fixture({ generate });
    f.host.messageEnd(f.record, f.ctx, userMessage);
    f.host.settled(f.record, f.ctx);
    await tick(31_000);
    await tick(31_000);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(String(f.notify.mock.calls[0]![0])).toContain("provider unavailable");
    f.host.settled(f.record, f.ctx);
    await tick(120_000);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(f.record.name).toBe("fix the native recovery race in session restore");
  });

  it("stops with one notice when the configured naming model is unusable", async () => {
    vi.useFakeTimers();
    const f = fixture({ nameModel: "acme/ghost", realGenerator: true });
    f.host.messageEnd(f.record, f.ctx, userMessage);
    f.host.settled(f.record, f.ctx);
    await tick(120_000);
    expect(f.find).toHaveBeenCalledWith("acme", "ghost");
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(String(f.notify.mock.calls[0]![0])).toContain("Unknown naming model: acme/ghost");
    expect(f.setSessionName).toHaveBeenCalledTimes(1);
    expect(f.record.name).toBe(extractiveName(FIRST_MESSAGE));
  });

  it("drops queued and in-flight work when the host closes", async () => {
    vi.useFakeTimers();
    let resolve!: (name: string) => void;
    const f = fixture({ generate: () => new Promise<string>((done) => { resolve = done; }) });
    f.host.settled(f.record, f.ctx);
    await tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    f.record.runtime = undefined;
    await f.host.close();
    resolve("Late title");
    await tick();
    expect(f.setSessionName).toHaveBeenCalledTimes(1);
    expect(f.setSessionName).not.toHaveBeenCalledWith("Late title");
    expect(f.record.name).toBe(extractiveName(FIRST_MESSAGE));
  });

  it("titles through the configured naming model when it resolves", async () => {
    vi.useFakeTimers();
    const f = fixture({ nameModel: "acme/tiny", realGenerator: true });
    const model = { id: "tiny" };
    f.find.mockReturnValue(model);
    const streamSimple = vi.fn((..._args: unknown[]) => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Tiny model title" }] }) }));
    (f.ctx.modelRegistry as unknown as { hasConfiguredAuth: (model: unknown) => boolean; streamSimple: unknown }).hasConfiguredAuth = () => true;
    (f.ctx.modelRegistry as unknown as { streamSimple: unknown }).streamSimple = streamSimple;
    f.host.settled(f.record, f.ctx);
    await tick();
    expect(f.find).toHaveBeenCalledWith("acme", "tiny");
    expect(streamSimple.mock.calls[0]![0]).toBe(model);
    expect(f.setSessionName).toHaveBeenLastCalledWith("Tiny model title");
  });
});
