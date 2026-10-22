import { afterEach, describe, expect, it } from "vitest";
import { closeSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertManagedFile, plainText, privateAppend, privateDirectory, readPrivateJSON } from "../src/core/security.js";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js";

const roots: string[] = [];
function temporary() { const root = mkdtempSync(join(tmpdir(), "pi-security-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("filesystem boundaries", () => {
  it("uses private directories and logs", () => {
    const root = temporary(), directory = join(root, "app"), log = join(directory, "host.log");
    privateDirectory(directory);
    closeSync(privateAppend(log));
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it("rejects symlinked state and log targets without changing their bytes", () => {
    const root = temporary(), target = join(root, "target"), alias = join(root, "alias");
    mkdirSync(target); symlinkSync(target, alias);
    expect(() => privateDirectory(alias)).toThrow(/Unsafe|Symlinked/);
    const file = join(root, "external"); writeFileSync(file, "untouched");
    symlinkSync(file, join(root, "host.log"));
    expect(() => privateAppend(join(root, "host.log"))).toThrow();
    expect(readFileSync(file, "utf8")).toBe("untouched");
  });

  it("rejects escaped, symlinked, and hard-linked managed histories", () => {
    const root = temporary(), sessions = join(root, "sessions"), inside = join(sessions, "one.jsonl"), outside = join(root, "outside.jsonl");
    mkdirSync(sessions); writeFileSync(inside, "{}"); writeFileSync(outside, "{}");
    expect(() => assertManagedFile(sessions, inside)).not.toThrow();
    expect(() => assertManagedFile(sessions, outside)).toThrow(/escaped/);
    symlinkSync(inside, join(sessions, "alias.jsonl"));
    expect(() => assertManagedFile(sessions, join(sessions, "alias.jsonl"))).toThrow();
    linkSync(inside, join(sessions, "hard.jsonl"));
    expect(() => assertManagedFile(sessions, inside)).toThrow();
    symlinkSync(outside, join(root, "registry.json"));
    expect(() => readPrivateJSON(join(root, "registry.json"))).toThrow(/Unsafe/);
  });

  it("removes terminal control sequences from metadata", () => {
    expect(plainText("name\x1b[31mred\x1b[0m\x1b]52;c;secret\x07\nnext")).toBe("namered next");
  });
});

describe("configuration", () => {
  it("defaults to launch attachment, a full-screen board, a one hour idle timeout, and fresh launch sessions", () => {
    expect(loadConfig(temporary())).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.idleTimeoutMs).toBe(3_600_000);
    expect(DEFAULT_CONFIG.boardFullscreen).toBe(true);
    expect(DEFAULT_CONFIG.autoAttach).toBe(true);
    expect(DEFAULT_CONFIG.resumeLastSession).toBe(false);
  });

  it("accepts a launch that reopens the directory's last session", () => {
    const root = temporary(); mkdirSync(join(root, "pi-codex-agents"));
    writeFileSync(join(root, "pi-codex-agents", "config.json"), '{"resumeLastSession":true}');
    expect(loadConfig(root).resumeLastSession).toBe(true);
  });

  it("accepts a framed command center", () => {
    const root = temporary(); mkdirSync(join(root, "pi-codex-agents"));
    writeFileSync(join(root, "pi-codex-agents", "config.json"), '{"boardFullscreen":false}');
    expect(loadConfig(root).boardFullscreen).toBe(false);
  });

  it.each([['{"historyImport":"false"}', "boolean"], ['{"unknown":true}', "Unknown"], ['{"idleTimeoutMs":-1}', "non-negative"], ['{"boardFullscreen":"yes"}', "boolean"], ['[]', "object"]])("rejects invalid config %s", (contents, error) => {
    const root = temporary(); mkdirSync(join(root, "pi-codex-agents"));
    writeFileSync(join(root, "pi-codex-agents", "config.json"), contents);
    expect(() => loadConfig(root)).toThrow(error);
  });
});
