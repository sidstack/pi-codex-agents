import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NativeSessionHost, type Session } from "../src/core/sessions.js";
import { DEFAULT_CONFIG } from "../src/config.js";

describe("command center opening", () => {
  it("reserves the board before asynchronous refresh and resets after failure", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((done) => { release = done; });
    const refresh = vi.fn(async () => barrier);
    const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal), DEFAULT_CONFIG, [{ id: "fixture", refresh }]);
    const custom = vi.fn(async () => undefined);
    const ctx = { hasUI: true, ui: { custom } } as unknown as ExtensionContext;
    const first = host.open(ctx);
    await host.open(ctx);
    expect(refresh).toHaveBeenCalledOnce();
    release();
    await first;
    expect(custom).toHaveBeenCalledOnce();
    refresh.mockRejectedValueOnce(new Error("refresh unavailable"));
    await expect(host.open(ctx)).rejects.toThrow("refresh unavailable");
    await host.open(ctx);
    expect(custom).toHaveBeenCalledTimes(2);
  });
});

describe("new session keys", () => {
  function boardHost(action: Record<string, unknown>, picked?: string) {
    const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal), DEFAULT_CONFIG, []);
    const record: Session = { id: "home", cwd: "/tmp/viewed", name: "Home", activity: "ready", running: false, prompts: 0, unread: false };
    host.sessions.set("home", record);
    host.activeId = "home";
    const custom = vi.fn(async () => (custom.mock.calls.length === 1 ? action : picked));
    const ctx = { hasUI: true, cwd: "/tmp/viewed", ui: { custom } } as unknown as ExtensionContext;
    return { host, record, custom, ctx, createAt: vi.spyOn(host, "createAt").mockResolvedValue(undefined) };
  }

  it("creates in the directory being viewed without asking for a path", async () => {
    const { host, custom, ctx, createAt } = boardHost({ kind: "new" });

    await host.open(ctx);
    expect(custom).toHaveBeenCalledOnce();
    expect(createAt).toHaveBeenCalledWith(ctx, "/tmp/viewed");
  });

  it("opens a directory choice on the picker key and creates in what it returns", async () => {
    const { host, custom, ctx, createAt } = boardHost({ kind: "pick" }, "/tmp/picked");

    await host.open(ctx);
    expect(custom).toHaveBeenCalledTimes(2);
    expect(createAt).toHaveBeenCalledWith(ctx, "/tmp/picked");
  });

  it("counts its own dialogs as host-owned, so a session never looks like it needs input", async () => {
    const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal), DEFAULT_CONFIG, []);
    const record: Session = { id: "home", cwd: "/tmp/viewed", name: "Home", activity: "ready", running: false, prompts: 0, unread: false };
    host.sessions.set("home", record);
    host.activeId = "home";
    const seen: boolean[] = [];
    const custom = vi.fn(async () => {
      seen.push(host.isHostPrompt(record, "custom"));
      return custom.mock.calls.length === 1 ? { kind: "pick" } : "/tmp/picked";
    });
    const ctx = { hasUI: true, cwd: "/tmp/viewed", ui: { custom } } as unknown as ExtensionContext;
    const createAt = vi.spyOn(host, "createAt").mockResolvedValue(undefined);

    await host.open(ctx);
    // Both the board and the picker are host-owned while they are open, and neither is afterwards.
    expect(seen).toEqual([true, true]);
    expect(host.isHostPrompt(record, "custom")).toBe(false);
    expect(createAt).toHaveBeenCalledWith(ctx, "/tmp/picked");
  });

  it("creates nothing when the picker is cancelled", async () => {
    const { host, custom, ctx, createAt } = boardHost({ kind: "pick" }, undefined);

    await host.open(ctx);
    expect(custom).toHaveBeenCalledTimes(2);
    expect(createAt).not.toHaveBeenCalled();
  });
});
