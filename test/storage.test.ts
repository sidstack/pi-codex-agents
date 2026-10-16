import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeDraftStore } from "../src/core/drafts.js";
import { writeNativeRegistry } from "../src/core/storage.js";

const roots: string[] = [];
function root(): string { const path = mkdtempSync(join(tmpdir(), "pi-state-test-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("bounded durable state", () => {
  it("rejects an oversized write before replacing or locking usable state", () => {
    const path = join(root(), "registry.json");
    writeNativeRegistry(path, { healthy: true }, 64);
    const before = readFileSync(path, "utf8");
    expect(() => writeNativeRegistry(path, { draft: "x".repeat(100) }, 64)).toThrow("previous state was preserved");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
  it("round-trips drafts larger than the wire limit independently of the registry", () => {
    const directory = root();
    const store = new NativeDraftStore(directory);
    const draft = "x".repeat(5 * 1024 * 1024);
    store.save("../untrusted-id", draft);
    expect(new NativeDraftStore(directory).load("../untrusted-id")).toBe(draft);
    expect(store.load("../untrusted-id", "newer inline state")).toBe("newer inline state");
    expect(existsSync(join(directory, "untrusted-id.json"))).toBe(false);
  });
});
