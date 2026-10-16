import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverNativeHistory } from "../src/features/history-source.js";
import { acquireNativeLock, writeNativeRegistry } from "../src/core/storage.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-native-discovery-")); roots.push(root); return root;
}

describe("native persistence and discovery", () => {
  it("finds saved history without reading managed storage or altering source bytes", async () => {
    const root = await temporary();
    await mkdir(join(root, "old")); await mkdir(join(root, "daemon"));
    const text = `${JSON.stringify({ type: "session", id: "original", cwd: "/project" })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "line\u2028separator" } })}\n{"partial":`;
    await writeFile(join(root, "old", "session.jsonl"), text);

    const sessions = await discoverNativeHistory(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ cwd: "/project", sourceFile: join(root, "old", "session.jsonl") });
    expect(await readFile(join(root, "old", "session.jsonl"), "utf8")).toBe(text);
  });

  it("refuses a live writer and safely replaces a dead owner's registry lock", async () => {
    const root = await temporary();
    const path = join(root, "registry.json");
    const release = acquireNativeLock(`${path}.lock`);
    expect(() => writeNativeRegistry(path, { sessions: [] })).toThrow(/already owns/);
    release();
    await writeFile(`${path}.lock`, JSON.stringify({ pid: process.pid, identity: "a different process incarnation" }));
    writeNativeRegistry(path, { sessions: [{ id: "one" }] });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ sessions: [{ id: "one" }] });
  });

});
