import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const { ensure, attach, stopHost } = vi.hoisted(() => ({ ensure: vi.fn(), attach: vi.fn(), stopHost: vi.fn() }));
vi.mock("../src/pi/client.js", () => ({ ensureNativeConnection: ensure, stopNativeHost: stopHost }));
vi.mock("../src/pi/attachment.js", () => ({ attachTerminal: attach }));
import extension from "../src/extension.js";

function fixture() {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const api = {
    registerTool: vi.fn(),
    registerCommand: vi.fn((name, options) => commands.set(name, options)),
    registerShortcut: vi.fn(),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
  };
  let listener: ((data: string) => unknown) | undefined;
  const tui = { start: vi.fn(), stop: vi.fn(), requestRender: vi.fn(), terminal: {} };
  const ctx = {
    cwd: "/tmp/project", hasUI: true, mode: "tui",
    ui: {
      getEditorText: vi.fn(() => ""), notify: vi.fn(),
      confirm: vi.fn(async () => false),
      onTerminalInput: vi.fn((fn) => { listener = fn; return vi.fn(); }),
      custom: vi.fn((factory) => new Promise<void>((done) => { factory(tui, {}, {}, done); })),
    },
    shutdown: vi.fn(),
  } as unknown as ExtensionContext;
  const socket = { destroy: vi.fn(), end: vi.fn() };
  ensure.mockResolvedValue({ socket });
  attach.mockResolvedValue({ reason: "Returned to Pi", quitFrontend: false });
  extension(api as unknown as ExtensionAPI);
  handlers.get("session_start")?.({}, ctx);
  return { api, commands, ctx, tui, socket, key: (data: string) => listener?.(data) };
}

// The launcher reads ambient Pi state and its own daemon marker, so each case
// runs against an isolated agent directory instead of the developer's session.
const managed: string[] = [];
const ambient = ["PI_AGENTS_DIR", "PI_AGENTS_NATIVE_DIR", "PI_AGENTS_IDLE_MS", "PI_AGENTS_NATIVE_DAEMON"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "pi-extension-test-"));
  managed.push(root);
  for (const name of ambient) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    delete process.env[name];
  }
  process.env.PI_AGENTS_DIR = root;
  process.env.PI_AGENTS_NATIVE_DIR = join(root, "host");
});

afterEach(() => {
  for (const name of ambient) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  for (const root of managed.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("Pi extension entry point", () => {
  it("explains leave from ordinary Pi without attaching", async () => {
    const { commands, ctx } = fixture();
    await commands.get("agents")!.handler("leave", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/already|outside|detached/i), "info");
    expect(attach).not.toHaveBeenCalled();
  });
  it.each([{ running: true, prompts: 0 }, { running: false, prompts: 1 }])("confirms failed sessions that still own work: %j", async (state) => {
    const { commands, ctx, socket } = fixture();
    ensure.mockResolvedValueOnce({ socket, request: vi.fn(async () => ({
      attached: false, capabilities: ["settledStop", "safeUpdate"],
      sessions: [{ activity: "failed", unread: false, ...state }],
    })) });
    await commands.get("agents")!.handler("restart", ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Restart the agent host?", expect.stringContaining("1 session(s) are running or waiting"));
    expect(stopHost).not.toHaveBeenCalled();
  });

  it("opens from empty-editor Left Arrow and restores the original TUI", async () => {
    const { key, tui, socket } = fixture();
    expect(key("\x1b[D")).toEqual({ consume: true });
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(tui.start).toHaveBeenCalledOnce());
    expect(tui.stop).toHaveBeenCalledOnce();
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("leaves Left Arrow to Pi when the editor contains a draft", () => {
    const { key, ctx } = fixture();
    vi.mocked(ctx.ui.getEditorText).mockReturnValue("draft");
    expect(key("\x1b[D")).toBeUndefined();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("intercepts Ctrl+G before Pi can launch an external editor", async () => {
    const { key, ctx } = fixture();
    vi.mocked(ctx.ui.getEditorText).mockReturnValue("draft");
    expect(key("\x07")).toEqual({ consume: true });
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
  });

  it("restores Pi after an attachment failure", async () => {
    const { commands, ctx, tui } = fixture();
    attach.mockRejectedValueOnce(new Error("host lost"));
    await commands.get("agents")!.handler("", ctx);
    expect(tui.start).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith("host lost", "error");
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });

  it("quits Pi when the host reports a quit chosen inside a managed view", async () => {
    const { commands, ctx, tui } = fixture();
    attach.mockResolvedValueOnce({ reason: "Sessions remain running in the background. Exiting Pi.", quitFrontend: true });
    await commands.get("agents")!.handler("", ctx);
    expect(tui.start).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Sessions remain running in the background. Exiting Pi.", "info");
    expect(ctx.shutdown).toHaveBeenCalledOnce();
  });

  it("keeps Pi when the host only detached or stopped sessions", async () => {
    const { commands, ctx } = fixture();
    attach.mockResolvedValueOnce({ reason: "Managed sessions stopped. Returned to Pi.", quitFrontend: false });
    await commands.get("agents")!.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Managed sessions stopped. Returned to Pi.", "info");
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });

  it("does not recursively install the launcher in managed runtimes", () => {
    const previous = process.env.PI_AGENTS_NATIVE_DAEMON;
    try {
      process.env.PI_AGENTS_NATIVE_DAEMON = "1";
      const { api } = fixture();
      expect(api.registerCommand).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.PI_AGENTS_NATIVE_DAEMON;
      else process.env.PI_AGENTS_NATIVE_DAEMON = previous;
    }
  });
});
