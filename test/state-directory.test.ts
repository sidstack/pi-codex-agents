import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DIR_NAME, LEGACY_APP_DIR_NAME, appDirectory, loadConfig, nativeHostDirectory, prepareAppDirectory } from "../src/config.js";
import { processIdentity } from "../src/core/storage.js";

const ENV_NAMES = ["PI_CODEX_AGENTS_DIR", "PI_AGENTS_DIR", "PI_CODEX_AGENTS_NATIVE_DIR", "PI_AGENTS_NATIVE_DIR"] as const;
const roots: string[] = [];
const saved = new Map<string, string | undefined>();
function temporary() { const root = mkdtempSync(join(tmpdir(), "pi-state-dir-")); roots.push(root); return root; }

beforeEach(() => { for (const name of ENV_NAMES) saved.set(name, process.env[name]); for (const name of ENV_NAMES) delete process.env[name]; });
afterEach(() => {
  for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  saved.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("state directory naming", () => {
  it("uses the package name and keeps the shorter names as overrides", () => {
    const agent = temporary();
    expect(appDirectory(agent)).toBe(join(agent, APP_DIR_NAME));
    process.env.PI_AGENTS_DIR = join(agent, "legacy-override");
    expect(appDirectory(agent)).toBe(join(agent, "legacy-override"));
    process.env.PI_CODEX_AGENTS_DIR = join(agent, "current-override");
    expect(appDirectory(agent)).toBe(join(agent, "current-override"));
  });

  it("keeps using the legacy directory until its state actually moves", () => {
    const agent = temporary();
    mkdirSync(join(agent, LEGACY_APP_DIR_NAME));
    expect(appDirectory(agent)).toBe(join(agent, LEGACY_APP_DIR_NAME));
    mkdirSync(join(agent, APP_DIR_NAME));
    expect(appDirectory(agent)).toBe(join(agent, APP_DIR_NAME));
  });

  it("resolves host state under the app directory and honors either override name", () => {
    const agent = temporary();
    expect(nativeHostDirectory(agent)).toBe(join(agent, APP_DIR_NAME, "host"));
    process.env.PI_AGENTS_NATIVE_DIR = join(agent, "old-host");
    expect(nativeHostDirectory(agent)).toBe(join(agent, "old-host"));
    process.env.PI_CODEX_AGENTS_NATIVE_DIR = join(agent, "new-host");
    expect(nativeHostDirectory(agent)).toBe(join(agent, "new-host"));
  });

  it("reads config from the renamed directory and names the package in failures", () => {
    const agent = temporary();
    mkdirSync(join(agent, APP_DIR_NAME));
    writeFileSync(join(agent, APP_DIR_NAME, "config.json"), '{"boardFullscreen":false}');
    expect(loadConfig(agent).boardFullscreen).toBe(false);
    writeFileSync(join(agent, APP_DIR_NAME, "config.json"), '{"nameModel":"acme/tiny"}');
    expect(loadConfig(agent).nameModel).toBe("acme/tiny");
    writeFileSync(join(agent, APP_DIR_NAME, "config.json"), '{"nameModel":""}');
    expect(loadConfig(agent).nameModel).toBe("");
    writeFileSync(join(agent, APP_DIR_NAME, "config.json"), '{"nameModel":"tiny"}');
    expect(() => loadConfig(agent)).toThrow("nameModel must be empty");
    writeFileSync(join(agent, APP_DIR_NAME, "config.json"), '{"unknown":true}');
    expect(() => loadConfig(agent)).toThrow("Unknown pi-codex-agents config option");
    writeFileSync(join(agent, APP_DIR_NAME, "config.json"), "[1]");
    expect(() => loadConfig(agent)).toThrow("pi-codex-agents config must be an object");
  });

  it("still reads a config left in the pre-rename directory", () => {
    const agent = temporary();
    mkdirSync(join(agent, LEGACY_APP_DIR_NAME));
    writeFileSync(join(agent, LEGACY_APP_DIR_NAME, "config.json"), '{"resumeLastSession":true}');
    expect(loadConfig(agent).resumeLastSession).toBe(true);
  });
});

describe("one-time state migration", () => {
  it("moves the pre-rename directory and keeps its contents", () => {
    const agent = temporary();
    mkdirSync(join(agent, LEGACY_APP_DIR_NAME, "host", "drafts"), { recursive: true });
    writeFileSync(join(agent, LEGACY_APP_DIR_NAME, "config.json"), '{"autoAttach":false}');
    writeFileSync(join(agent, LEGACY_APP_DIR_NAME, "host", "registry.json"), "{}");
    const state = prepareAppDirectory(agent);
    expect(state.directory).toBe(join(agent, APP_DIR_NAME));
    expect(state.notice).toContain(APP_DIR_NAME);
    expect(existsSync(join(agent, LEGACY_APP_DIR_NAME))).toBe(false);
    expect(loadConfig(agent).autoAttach).toBe(false);
    expect(readFileSync(join(agent, APP_DIR_NAME, "host", "registry.json"), "utf8")).toBe("{}");
    // A second start has nothing left to move and says nothing.
    expect(prepareAppDirectory(agent)).toEqual({ directory: join(agent, APP_DIR_NAME) });
  });

  it("leaves a directory a running host still owns and reports how to finish", () => {
    const agent = temporary();
    mkdirSync(join(agent, LEGACY_APP_DIR_NAME, "host"), { recursive: true });
    writeFileSync(join(agent, LEGACY_APP_DIR_NAME, "host", "host.lock"), JSON.stringify({ pid: process.pid, identity: processIdentity() }));
    const state = prepareAppDirectory(agent);
    expect(state.directory).toBe(join(agent, LEGACY_APP_DIR_NAME));
    expect(state.notice).toContain("/agents stop");
    expect(existsSync(join(agent, LEGACY_APP_DIR_NAME, "host", "host.lock"))).toBe(true);
    expect(existsSync(join(agent, APP_DIR_NAME))).toBe(false);
  });

  it("reclaims a directory whose host died without releasing its lock", () => {
    const agent = temporary();
    mkdirSync(join(agent, LEGACY_APP_DIR_NAME, "host"), { recursive: true });
    writeFileSync(join(agent, LEGACY_APP_DIR_NAME, "host", "host.lock"), JSON.stringify({ pid: 2_147_483_646, identity: "gone" }));
    expect(prepareAppDirectory(agent).directory).toBe(join(agent, APP_DIR_NAME));
  });

  it("uses the renamed directory when both exist and never merges them", () => {
    const agent = temporary();
    mkdirSync(join(agent, LEGACY_APP_DIR_NAME));
    writeFileSync(join(agent, LEGACY_APP_DIR_NAME, "config.json"), '{"autoAttach":false}');
    mkdirSync(join(agent, APP_DIR_NAME));
    writeFileSync(join(agent, APP_DIR_NAME, "config.json"), '{"autoAttach":true}');
    const state = prepareAppDirectory(agent);
    expect(state.directory).toBe(join(agent, APP_DIR_NAME));
    expect(state.notice).toContain(LEGACY_APP_DIR_NAME);
    expect(loadConfig(agent).autoAttach).toBe(true);
    expect(readFileSync(join(agent, LEGACY_APP_DIR_NAME, "config.json"), "utf8")).toBe('{"autoAttach":false}');
  });

  it("never moves a directory an environment variable selected", () => {
    const agent = temporary();
    mkdirSync(join(agent, LEGACY_APP_DIR_NAME));
    const selected = temporary();
    process.env.PI_AGENTS_DIR = selected;
    expect(prepareAppDirectory(agent)).toEqual({ directory: selected });
    expect(existsSync(join(agent, LEGACY_APP_DIR_NAME))).toBe(true);
  });

  it("refuses to move a symlinked state directory", () => {
    const agent = temporary();
    const target = temporary();
    symlinkSync(target, join(agent, LEGACY_APP_DIR_NAME));
    expect(() => prepareAppDirectory(agent)).toThrow(/Symlinked/);
    expect(existsSync(target)).toBe(true);
  });
});
