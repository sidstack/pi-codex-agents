import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@earendil-works/pi-tui";
import { NativeSessionHost } from "../src/core/sessions.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { configuredFeatures } from "../src/features/index.js";
import { commandCenterKey } from "../src/features/navigation.js";
import { statusParts } from "../src/features/status.js";
import type { SessionFeature } from "../src/features/contracts.js";

const disabled = { ...DEFAULT_CONFIG, autoName: false, historyImport: false, leftArrowEntry: false,
  commandCenterShortcut: false, sessionCycling: false, showStatus: false, autoInactive: false };

afterEach(() => { vi.useRealTimers(); });

describe("optional feature assembly", () => {
  it("keeps the session engine available with every feature disabled", async () => {
    const features = configuredFeatures(disabled);
    expect(features).toEqual([]);
    const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal), disabled, features);
    expect(typeof host.create).toBe("function");
    expect(typeof host.open).toBe("function");
    expect(typeof host.activate).toBe("function");
    expect(commandCenterKey(disabled, "\x07", true, 0)).toBe(false);
    expect(commandCenterKey(disabled, "\x1b[D", true, 0)).toBe(false);
    host.startFeatures();
    await host.refreshFeatures();
    await host.close();
  });

  it("assembles independently enabled blocks", () => {
    expect(configuredFeatures(DEFAULT_CONFIG).map((feature) => feature.id)).toEqual(["naming", "history", "inactivity", "navigation", "status"]);
    expect(configuredFeatures({ ...disabled, historyImport: true }).map((feature) => feature.id)).toEqual(["history"]);
    expect(configuredFeatures({ ...disabled, showStatus: true }).map((feature) => feature.id)).toEqual(["status"]);
  });

  it("owns feature hooks and cleans up once on close", async () => {
    const cleanup = vi.fn();
    const feature: SessionFeature = { id: "fixture", start: vi.fn(() => cleanup), refresh: vi.fn(async () => {}), changed: vi.fn() };
    const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal), DEFAULT_CONFIG, [feature]);
    host.startFeatures();
    host.startFeatures();
    await host.refreshFeatures();
    host.onChange();
    await host.close();
    await host.close();
    host.onChange();
    host.startFeatures();
    expect(feature.start).toHaveBeenCalledOnce();
    expect(feature.refresh).toHaveBeenCalledOnce();
    expect(feature.changed).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("stops inactivity scheduling when the host closes", async () => {
    vi.useFakeTimers();
    const config = { ...disabled, autoInactive: true, idleTimeoutMs: 1000 };
    const host = new NativeSessionHost("/tmp/agent", () => ({} as Terminal), config, configuredFeatures(config));
    const deactivate = vi.spyOn(host, "deactivateIdle").mockResolvedValue();
    host.startFeatures();
    await vi.advanceTimersByTimeAsync(1000);
    expect(deactivate).toHaveBeenCalledOnce();
    await host.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(deactivate).toHaveBeenCalledOnce();
  });

  it("rejects duplicate feature IDs", () => {
    expect(() => new NativeSessionHost("/tmp/agent", () => ({} as Terminal), DEFAULT_CONFIG, [{ id: "x" }, { id: "x" }])).toThrow("Duplicate");
  });

  it("summarizes sessions the way the command center chips read", () => {
    const busy = [{ activity: "running" }, { activity: "waiting" }, { activity: "waiting", unread: true },
      { activity: "ready" }, { activity: "inactive" }, { activity: "stopped" }] as const;
    expect(statusParts(busy)).toEqual(["sessions 6", "1 running", "2 needs input", "1 ready", "2 inactive", "1 unread"]);
    expect(statusParts([{ activity: "failed", unread: true }])).toEqual(["sessions 1", "0 running", "0 needs input", "0 ready", "1 failed", "1 unread"]);
    // Quiet fleets stay short: empty groups are not printed.
    expect(statusParts([{ activity: "ready" }, { activity: "running" }])).toEqual(["sessions 2", "1 running", "0 needs input", "1 ready"]);
  });
});

describe("feature dependency boundaries", () => {
  it("keeps concrete feature imports out of the core", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const directory = new URL("../src/core/", import.meta.url);
    for (const name of await readdir(directory)) {
      const source = await readFile(new URL(name, directory), "utf8");
      const imports = source.split("\n").filter((line) => line.includes("features/"));
      for (const line of imports) expect(line, name).toMatch(/^import type .*features\/contracts\.js/);
    }
  });
});
