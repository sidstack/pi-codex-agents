import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NativeSessionHost } from "../src/core/sessions.js";
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
