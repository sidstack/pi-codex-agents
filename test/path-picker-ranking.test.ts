import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PathPicker, type PickerCandidate, type PickerProject } from "../src/ui/path-picker.js";

interface DiscoveryOptions {
  signal?: AbortSignal;
  onDiscovered?: (directories: readonly string[]) => void;
}

/**
 * Background discovery is replaced so this file never runs a real filesystem scan and no
 * automatic `onDiscovered` callback can land mid-test. The scan promise stays in flight, so the
 * only discovered path in the ordering assertions below is the one an explicit
 * `mergeDiscovered(...)` call injects. Without this, a BFS over the shared temp directory can
 * reach the sibling fixture within the settle window and make the pre-merge assertion flaky.
 */
const discovery = vi.hoisted(() => ({
  discoverDirectories: vi.fn((_options: DiscoveryOptions) => new Promise<never>(() => {})),
}));

vi.mock("../src/ui/path-index.js", () => ({ discoverDirectories: discovery.discoverDirectories }));

const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const settle = async (): Promise<void> => { await new Promise((done) => setTimeout(done, 150)); };

const candidates = (picker: PathPicker): PickerCandidate[] => (picker as unknown as { candidates: PickerCandidate[] }).candidates;

const candidateAt = (picker: PathPicker, index: number): PickerCandidate => {
  const candidate = candidates(picker)[index];
  if (!candidate) throw new Error(`missing candidate at index ${index}`);
  return candidate;
};

function openPicker(cwd: string, projects: PickerProject[] = []): PathPicker {
  return new PathPicker(projects, cwd, theme, () => {}, vi.fn(), () => 30, true);
}

describe("score-ranked candidate ordering", () => {
  it("keeps a high-scoring discovered match ahead of >40 prefix children", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sort-"));
    roots.push(root);
    for (let i = 1; i <= 50; i++) mkdirSync(join(root, `dep${String(i).padStart(2, "0")}`));
    const other = mkdtempSync(join(tmpdir(), "pi-sort-other-"));
    roots.push(other);
    const exact = join(other, "dep");
    mkdirSync(exact);
    const picker = openPicker(root);
    try {
      await settle();
      for (const character of "dep") picker.handleInput(character);
      await settle();
      // Old behavior: 50 children pushed first, slice(0, 40) drops the discovered match.
      expect(candidates(picker).length).toBe(40);
      expect(candidates(picker).some((candidate) => candidate.path === exact)).toBe(false);
      // Discovery ran but delivered nothing on its own, so the merge below is the only source.
      expect(discovery.discoverDirectories).toHaveBeenCalledTimes(1);
      (picker as unknown as { mergeDiscovered(paths: string[]): void }).mergeDiscovered([exact]);
      await settle();
      const list = candidates(picker);
      expect(candidateAt(picker, 0).path).toBe(exact); // score 100 beats children at 80
      expect(list.length).toBe(40);
    } finally { picker.dispose(); }
  });

  it("prefers known projects on equal scores, in recency order", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sort-"));
    roots.push(root);
    for (const name of ["alpha", "alphabet"]) mkdirSync(join(root, name));
    const picker = openPicker(root, [
      { cwd: join(root, "alphabet"), name: "Older", activity: "a", lastActivityAt: 100 },
      { cwd: "/tmp/known/alpha", name: "Newest", activity: "b", lastActivityAt: 500 },
    ]);
    try {
      await settle();
      for (const character of "alph") picker.handleInput(character);
      await settle();
      const list = candidates(picker);
      // "alpha" and "alphabet" both score 80 (prefix): known projects first, recency order.
      expect(candidateAt(picker, 0).path).toBe("/tmp/known/alpha");
      expect(candidateAt(picker, 0).existing).toBe(true);
      expect(candidateAt(picker, 1).path).toBe(join(root, "alphabet"));
      const childAlpha = list.findIndex((candidate) => candidate.path === join(root, "alpha"));
      expect(childAlpha).toBeGreaterThan(1);
    } finally { picker.dispose(); }
  });

  it("keeps a valid typed directory first", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sort-"));
    roots.push(root);
    for (const name of ["alpha", "alphabet"]) mkdirSync(join(root, name));
    const picker = openPicker(root);
    try {
      await settle();
      for (const character of `${root}/alpha`) picker.handleInput(character);
      await settle();
      expect(candidateAt(picker, 0)).toMatchObject({ path: join(root, "alpha"), source: "typed" });
    } finally { picker.dispose(); }
  });

  it("preserves empty-query ordering", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sort-"));
    roots.push(root);
    for (const name of ["beta", "alpha"]) mkdirSync(join(root, name));
    const picker = openPicker(root, [{ cwd: "/tmp/known/project", name: "Known", activity: "x", lastActivityAt: 500 }]);
    try {
      await settle();
      const list = candidates(picker);
      expect(candidateAt(picker, 0).source).toBe("here");
      expect(candidateAt(picker, 1).path).toBe("/tmp/known/project");
      expect(list.map((candidate) => candidate.path)).toContain(join(root, "alpha"));
    } finally { picker.dispose(); }
  });
});
