import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PathPicker, expandDirectory, listSubdirectories, matchesQuery, type PickerProject } from "../src/ui/path-picker.js";

const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-path-picker-"));
  roots.push(root);
  for (const name of ["alpha", "alphabet", "beta", ".hidden"]) mkdirSync(join(root, name));
  return root;
}

const settle = async (): Promise<void> => { await new Promise((done) => setTimeout(done, 150)); };

function openPicker(cwd: string, projects: PickerProject[] = []): { picker: PathPicker; done: ReturnType<typeof vi.fn>; text: () => string } {
  const done = vi.fn();
  const instance = new PathPicker(projects, cwd, theme, () => {}, done, () => 30, true);
  return { picker: instance, done, text: () => instance.render(100).join("\n") };
}

describe("directory choice for a new session", () => {
  it("resolves ~ and relative paths against the session the picker was opened from", () => {
    expect(expandDirectory("~/code", "/tmp/project")).toBe(join(homedir(), "code"));
    expect(expandDirectory("sub", "/tmp/project")).toBe("/tmp/project/sub");
    expect(expandDirectory("/absolute/dir", "/tmp/project")).toBe("/absolute/dir");
    expect(expandDirectory("   ", "/tmp/project")).toBe("/tmp/project");
  });

  it("matches a project by substring or by subsequence", () => {
    expect(matchesQuery("codex", "/home/siddu/Projects/pi-codex-agents")).toBe(true);
    expect(matchesQuery("pca", "/home/siddu/Projects/pi-codex-agents")).toBe(true);
    expect(matchesQuery("", "/any/path")).toBe(true);
    expect(matchesQuery("zz", "/home/siddu/Projects/pi-codex-agents")).toBe(false);
  });

  it("lists only directories, sorted, and reports a truncated listing", async () => {
    const root = tree();
    const listing = await listSubdirectories(root);
    expect(listing.entries).toEqual([".hidden", "alpha", "alphabet", "beta"]);
    expect(listing.truncated).toBe(false);
    expect((await listSubdirectories(join(root, "alpha"))).entries).toEqual([]);
    expect((await listSubdirectories("/definitely/not/here")).entries).toEqual([]);
    expect((await listSubdirectories(root, 2)).truncated).toBe(true);
  });

  it("offers this directory, recent projects, and child directories before any typing", async () => {
    const root = tree();
    const { picker, text } = openPicker(root, [{ cwd: "/tmp/known/project", name: "Known", activity: "ready", lastActivityAt: 500 }]);
    try {
      await settle();
      const shown = text();
      expect(shown).toContain("this directory");
      expect(shown).toContain("/tmp/known/project");
      expect(shown).toContain("alpha");
      expect(shown).toContain("beta");
      expect(shown).not.toContain(".hidden");
      expect(shown).toContain("›");
    } finally { picker.dispose(); }
  });

  it("completes a typed fragment and chooses the completion on Enter", async () => {
    const root = tree();
    const { picker, done, text } = openPicker(root);
    try {
      await settle();
      for (const character of "alph") picker.handleInput(character);
      await settle();
      const shown = text();
      expect(shown).toContain(join(root, "alpha"));
      expect(shown).toContain(join(root, "alphabet"));
      expect(shown).not.toContain(join(root, "beta"));
      picker.handleInput("\r");
      await settle();
      expect(done).toHaveBeenCalledWith(join(root, "alpha"));
    } finally { picker.dispose(); }
  });

  it("keeps a complete typed path ahead of its own children", async () => {
    const root = tree();
    const { picker, done } = openPicker(root);
    try {
      await settle();
      for (const character of `${root}/alpha`) picker.handleInput(character);
      await settle();
      picker.handleInput("\r");
      await settle();
      expect(done).toHaveBeenCalledWith(join(root, "alpha"));
    } finally { picker.dispose(); }
  });

  it("never chooses from a listing that is still being computed", async () => {
    const root = tree();
    const { picker, done } = openPicker(root);
    try {
      await settle();
      // Type a complete path and press Enter in the same beat: the stale first candidate
      // is this directory, so a listing race would open the wrong session.
      for (const character of `${root}/beta`) picker.handleInput(character);
      picker.handleInput("\r");
      await settle();
      expect(done).toHaveBeenCalledWith(join(root, "beta"));
    } finally { picker.dispose(); }
  });

  it("accepts a path that does not exist yet so the caller can report it", async () => {
    const root = tree();
    const { picker, done } = openPicker(root);
    try {
      await settle();
      for (const character of "does-not-exist") picker.handleInput(character);
      await settle();
      picker.handleInput("\r");
      await settle();
      expect(done).toHaveBeenCalledWith(join(root, "does-not-exist"));
    } finally { picker.dispose(); }
  });

  it("completes the selection into the input on Tab and cancels on Escape", async () => {
    const root = tree();
    const { picker, done, text } = openPicker(root, [{ cwd: "/tmp/known/project", name: "Known", activity: "ready", lastActivityAt: 500 }]);
    try {
      await settle();
      picker.handleInput("\x1b[B"); // down to the recent project candidate
      picker.handleInput("\t");
      await settle();
      expect(text()).toContain("/tmp/known/project");
      picker.handleInput("\x1b");
      expect(done).toHaveBeenCalledWith(undefined);
    } finally { picker.dispose(); }
  });

  it("renders a full panel at the sizes the command center uses", async () => {
    const root = tree();
    const { picker, text } = openPicker(root);
    try {
      await settle();
      for (const width of [120, 80, 50]) {
        const lines = picker.render(width);
        expect(lines.length).toBeGreaterThanOrEqual(5);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      expect(text()).toContain("Enter choose");
    } finally { picker.dispose(); }
  });
});
