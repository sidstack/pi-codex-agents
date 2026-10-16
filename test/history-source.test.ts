import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeHistoryScanner } from "../src/features/history-source.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-history-source-")); roots.push(root); return root;
}

const EARLIER = new Date("2024-05-01T10:00:00.000Z");
const LATER = new Date("2024-05-02T10:00:00.000Z");

function history(name: string, cwd = "/project"): string {
  return [
    JSON.stringify({ type: "session", cwd }),
    JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
    JSON.stringify({ type: "session_info", name }),
  ].map((line) => `${line}\n`).join("");
}

/** Fixed mtimes keep cache invalidation deterministic without timing sleeps. */
async function writeHistory(path: string, content: string, modified: Date): Promise<void> {
  await writeFile(path, content);
  await utimes(path, modified, modified);
}

describe("NativeHistoryScanner", () => {
  it("re-reads a modified file instead of reporting the cached title", async () => {
    const root = await temporary();
    const file = join(root, "session.jsonl");
    const scanner = new NativeHistoryScanner();

    await writeHistory(file, history("Alpha name"), EARLIER);
    const first = await scanner.scan(root);
    expect(first.issues).toEqual([]);
    expect(first.sessions.map((session) => session.name)).toEqual(["Alpha name"]);
    expect(first.sessions[0]).toMatchObject({ cwd: "/project", modified: EARLIER.toISOString() });

    // Unchanged file: the cache answers the rescan.
    expect((await scanner.scan(root)).sessions.map((session) => session.name)).toEqual(["Alpha name"]);

    // Same byte size, newer mtime: only mtime can invalidate the cached title.
    await writeHistory(file, history("Bravo name"), LATER);
    const second = await scanner.scan(root);
    expect(second.issues).toEqual([]);
    expect(second.sessions.map((session) => session.name)).toEqual(["Bravo name"]);
    expect(second.sessions[0]?.modified).toBe(LATER.toISOString());
  });

  it("skips an excluded managed file before parsing it", async () => {
    const root = await temporary();
    const managed = join(root, "managed.jsonl");
    await writeFile(managed, `${"x".repeat(4096)}\n{not json}\n`);

    const discovery = await new NativeHistoryScanner({ recordBytes: 64 }).scan(root, new Set([managed]));
    expect(discovery.sessions).toEqual([]);
    expect(discovery.issues).toEqual([]);

    // A non-normalized exclusion path resolves to the same file.
    const nested = await new NativeHistoryScanner({ recordBytes: 64 })
      .scan(root, new Set([join(root, "sub", "..", "managed.jsonl")]));
    expect(nested.issues).toEqual([]);

    // Control: the same scanner does report the file when it is not excluded.
    const unfiltered = await new NativeHistoryScanner({ recordBytes: 64 }).scan(root);
    expect(unfiltered.sessions).toEqual([]);
    expect(unfiltered.issues).toHaveLength(1);
    expect(unfiltered.issues[0]).toContain("Malformed or oversized history record");
  });

  it("returns the healthy neighbor of a malformed or oversized history", async () => {
    const root = await temporary();
    await writeFile(join(root, "healthy.jsonl"), history("Healthy run", "/healthy"));
    await writeFile(join(root, "broken.jsonl"), `{{{ not json\n${"y".repeat(512)}\n`);

    const discovery = await new NativeHistoryScanner({ recordBytes: 128 }).scan(root);
    expect(discovery.sessions).toHaveLength(1);
    expect(discovery.sessions[0]).toMatchObject({ cwd: "/healthy", name: "Healthy run" });
    expect(discovery.issues).toHaveLength(1);
    expect(discovery.issues[0]).toContain("broken.jsonl");
    expect(discovery.issues[0]).toContain("Malformed or oversized history record");
  });

  it("reports partial discovery when the byte budget truncates a file", async () => {
    const root = await temporary();
    const filler = Array.from({ length: 40 }, () => JSON.stringify({
      type: "message", message: { role: "assistant", content: "p".repeat(100) },
    })).join("\n");
    // The session records sit beyond the budget, so nothing is discovered.
    await writeFile(join(root, "big.jsonl"), `${filler}\n${history("Late title", "/late")}`);

    const scanner = new NativeHistoryScanner({ bytes: 1024 });
    const discovery = await scanner.scan(root);
    expect(discovery.sessions).toEqual([]);
    expect(discovery.issues).toHaveLength(2);
    expect(discovery.issues[0]).toMatch(/big\.jsonl: Partial discovery: read budget \d+ of \d+ bytes/);
    expect(discovery.issues[1]).toContain("Partial discovery: exhausted 1024-byte scan budget");

    // A budget-truncated result is not cached, so the next refresh reports it again.
    expect((await scanner.scan(root)).issues).toHaveLength(2);
  });

  it("reports partial discovery when the entry budget stops the walk", async () => {
    const root = await temporary();
    await writeFile(join(root, "a.jsonl"), history("First run", "/one"));
    await writeFile(join(root, "b.jsonl"), history("Second run", "/two"));

    const discovery = await new NativeHistoryScanner({ entries: 1 }).scan(root);
    expect(discovery.sessions).toHaveLength(1);
    expect(discovery.issues).toHaveLength(1);
    expect(discovery.issues[0]).toContain("Partial discovery: exceeded 1 directory entries");
  });

  it("bounds returned metadata so optional discovery cannot overflow status transport", async () => {
    const root = await temporary();
    await writeFile(join(root, "a.jsonl"), history("First"));
    await writeFile(join(root, "b.jsonl"), history("Second"));
    const result = await new NativeHistoryScanner({ metadataBytes: 300 }).scan(root);
    expect(result.sessions).toHaveLength(1);
    expect(result.issues).toEqual([expect.stringContaining("metadata budget")]);
    expect(Buffer.byteLength(JSON.stringify(result.sessions))).toBeLessThan(302);
  });

  it("clears cached sessions so a later scan re-parses the file", async () => {
    const root = await temporary();
    const file = join(root, "session.jsonl");
    const scanner = new NativeHistoryScanner();

    await writeHistory(file, history("Alpha name"), EARLIER);
    expect((await scanner.scan(root)).sessions[0]?.name).toBe("Alpha name");

    // Equal size and equal mtime: only the cache can still report "Alpha name".
    await writeHistory(file, history("Bravo name"), EARLIER);
    expect((await scanner.scan(root)).sessions[0]?.name).toBe("Alpha name");

    scanner.clear();
    expect((await scanner.scan(root)).sessions[0]?.name).toBe("Bravo name");
  });
});
