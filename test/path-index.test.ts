import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PATH_INDEX_LIMITS, discoverDirectories } from "../src/ui/path-index.js";

const roots: string[] = [];

// Count lstat calls so "no validation work" is observable instead of timing-based.
const fsCalls = vi.hoisted(() => ({ lstat: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      fsCalls.lstat += 1;
      return actual.lstat(...args);
    },
  };
});

afterEach(() => {
  fsCalls.lstat = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `pi-path-index-${label}-`));
  roots.push(root);
  return root;
}

/** work/proj is the session cwd; work/projects/never-opened is two levels away and unopened. */
function workspace(): { cwd: string; work: string; neverOpened: string; legacy: string; home: string } {
  const root = tempRoot("ws");
  const work = join(root, "work");
  const cwd = join(work, "proj");
  mkdirSync(join(cwd, "src/app"), { recursive: true });
  const neverOpened = join(work, "projects", "never-opened");
  mkdirSync(join(neverOpened, "src"), { recursive: true });
  mkdirSync(join(cwd, "node_modules/pkg/deep"), { recursive: true });
  mkdirSync(join(cwd, ".git/objects"), { recursive: true });
  mkdirSync(join(cwd, ".cache"), { recursive: true });
  mkdirSync(join(root, "outside/legacy-project"), { recursive: true });
  symlinkSync(join(cwd, "src"), join(work, "alias"));
  return { cwd, work, neverOpened, legacy: join(root, "outside", "legacy-project"), home: join(root, "home") };
}

describe("bounded directory discovery", () => {
  it("finds a never-opened folder two levels away from the session cwd", async () => {
    const ws = workspace();
    const result = await discoverDirectories({ cwd: ws.cwd, home: ws.home });
    expect(result.directories).toContain(ws.neverOpened);
    expect(result.directories).toContain(join(ws.work, "projects"));
    expect(result.aborted).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.examined).toBeGreaterThan(0);
    expect(result.directories.indexOf(join(ws.work, "projects"))).toBeLessThan(result.directories.indexOf(ws.neverOpened));
  });

  it("retains known projects that live outside every discovery root", async () => {
    const ws = workspace();
    const elsewhere = tempRoot("elsewhere");
    const result = await discoverDirectories({
      cwd: join(elsewhere, "solo"),
      knownProjects: [ws.legacy, join(elsewhere, "gone")],
      home: join(elsewhere, "home"),
      maxDepth: 0,
    });
    expect(result.known).toEqual([ws.legacy]);
    expect(result.directories).toContain(ws.legacy);
    expect(result.directories).not.toContain(join(elsewhere, "gone"));
  });

  it("reserves cwd, parent and home roots when many known projects are configured", async () => {
    const ws = workspace();
    mkdirSync(join(ws.home, "home-app"), { recursive: true });
    const elsewhere = tempRoot("known-fanout");
    const knownProjects = [1, 2, 3, 4].map((index) => {
      const path = join(elsewhere, `group-${index}`, `known-${index}`);
      mkdirSync(join(path, "src"), { recursive: true });
      return path;
    });
    // Default maxRoots is 8: four known projects used to consume all eight roots and
    // silently drop the cwd-parent and home roots.
    const result = await discoverDirectories({ cwd: ws.cwd, knownProjects, home: ws.home });
    expect(result.known).toEqual(knownProjects);
    expect(result.directories).toContain(join(ws.work, "projects"));
    expect(result.directories).toContain(ws.neverOpened);
    expect(result.directories).toContain(join(ws.home, "home-app"));
  });

  it("caps total examined entries including files and reports truncation", async () => {
    const ws = workspace();
    mkdirSync(join(ws.cwd, "heavy"), { recursive: true });
    for (let index = 0; index < 400; index += 1) writeFileSync(join(ws.cwd, "heavy", `f${index}.txt`), "x");
    const capped = await discoverDirectories({ cwd: ws.cwd, home: ws.home, maxEntries: 120 });
    expect(capped.examined).toBeLessThanOrEqual(121);
    expect(capped.truncated).toBe(true);
    const unlimited = await discoverDirectories({ cwd: ws.cwd, home: ws.home });
    expect(unlimited.examined).toBeGreaterThan(capped.examined);
    expect(unlimited.truncated).toBe(false);
  });

  it("skips heavy trees and never follows symlinks", async () => {
    const ws = workspace();
    const result = await discoverDirectories({ cwd: ws.cwd, home: ws.home });
    expect(result.directories.some((path) => path.includes("node_modules"))).toBe(false);
    expect(result.directories.some((path) => path.includes(".git"))).toBe(false);
    expect(result.directories.some((path) => path.includes(".cache"))).toBe(false);
    expect(result.directories).toContain(join(ws.cwd, "src"));
    expect(result.directories.some((path) => path.includes("alias"))).toBe(false);
    expect(result.directories).not.toContain(join(ws.work, "alias"));
  });

  it("keeps the home pass shallow and never scans the filesystem root", async () => {
    const ws = workspace();
    const homeRoot = tempRoot("home");
    mkdirSync(join(homeRoot, "projects/home-app/deep/deeper"), { recursive: true });
    mkdirSync(join(homeRoot, ".ssh"), { recursive: true });
    const result = await discoverDirectories({ cwd: ws.cwd, home: homeRoot });
    expect(result.directories).toContain(join(homeRoot, "projects"));
    expect(result.directories).toContain(join(homeRoot, "projects", "home-app"));
    expect(result.directories).not.toContain(join(homeRoot, "projects", "home-app", "deep"));
    expect(result.directories.some((path) => path.includes(".ssh"))).toBe(false);

    const atRoot = await discoverDirectories({ cwd: "/", home: "/" });
    expect(atRoot.directories).toEqual([]);
    expect(atRoot.visited).toBe(0);
  });

  it("skips symlinked roots and symlinked known projects instead of following them", async () => {
    const root = tempRoot("symlink-roots");
    const elsewhere = tempRoot("symlink-target");
    const realProject = join(elsewhere, "real-project");
    mkdirSync(join(realProject, "src"), { recursive: true });
    mkdirSync(join(root, "home"), { recursive: true });
    const cwdLink = join(root, "cwd-link");
    symlinkSync(realProject, cwdLink);
    const knownLink = join(root, "known-link");
    symlinkSync(realProject, knownLink);

    const result = await discoverDirectories({ cwd: cwdLink, knownProjects: [knownLink], home: join(root, "home") });
    expect(result.known).toEqual([]);
    expect(result.directories).not.toContain(knownLink);
    expect(result.directories).not.toContain(realProject);
    // The symlinked cwd root must not be followed into the target tree either.
    expect(result.directories.some((path) => path.startsWith(`${elsewhere}/`))).toBe(false);
  });

  it("applies the shallow home limit when home is also the cwd parent", async () => {
    const root = tempRoot("home-parent");
    const cwd = join(root, "proj");
    mkdirSync(join(cwd, "src/app"), { recursive: true });
    mkdirSync(join(root, "sibling/deep/deeper"), { recursive: true });
    // home === dirname(cwd) (repo cloned directly into ~): the shared root keeps the
    // shallow maxHomeDepth of 2, so 'deeper' (level 3) is never reported.
    const result = await discoverDirectories({ cwd, home: root });
    expect(result.directories).toContain(join(root, "sibling"));
    expect(result.directories).toContain(join(root, "sibling", "deep"));
    expect(result.directories).not.toContain(join(root, "sibling", "deep", "deeper"));
    // The cwd root itself keeps the full maxDepth of 3.
    expect(result.directories).toContain(join(cwd, "src"));
    expect(result.directories).toContain(join(cwd, "src", "app"));
  });

  it("stops promptly on abort and keeps partial results", async () => {
    const ws = workspace();
    const baseline = await discoverDirectories({ cwd: ws.cwd, home: ws.home });
    expect(baseline.directories.length).toBeGreaterThan(1);

    const controller = new AbortController();
    controller.abort();
    const preAborted = await discoverDirectories({ cwd: ws.cwd, home: ws.home, signal: controller.signal });
    expect(preAborted.aborted).toBe(true);
    expect(preAborted.examined).toBe(0);
    expect(preAborted.directories).toEqual([]);

    const midFlight = new AbortController();
    const partial = await discoverDirectories({
      cwd: ws.cwd,
      home: ws.home,
      signal: midFlight.signal,
      onDiscovered: () => midFlight.abort(),
    });
    expect(partial.aborted).toBe(true);
    expect(partial.directories.length).toBeGreaterThan(0);
    expect(partial.directories.length).toBeLessThan(baseline.directories.length);
  });

  it("treats unreadable or vanished directories as empty, not as errors", async () => {
    const root = tempRoot("broken");
    const file = join(root, "not-a-dir.txt");
    writeFileSync(file, "x");
    const result = await discoverDirectories({
      cwd: file,
      knownProjects: [join(root, "deleted-project"), file],
      home: join(root, "home"),
    });
    expect(result.directories).toEqual([]);
    expect(result.known).toEqual([]);
    expect(result.aborted).toBe(false);
  });

  it("yields to the event loop between batches so the UI can paint during a scan", async () => {
    const root = tempRoot("yield");
    const cwd = join(root, "work", "proj");
    for (let index = 0; index < 40; index += 1) mkdirSync(join(cwd, `d${index}`, "leaf"), { recursive: true });
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 0);
    const result = await discoverDirectories({ cwd, home: join(root, "home") });
    clearInterval(interval);
    expect(result.truncated).toBe(false);
    expect(result.visited).toBeGreaterThan(8);
    expect(result.directories).not.toContain(cwd);
    expect(ticks).toBeGreaterThan(0);
  });

  it("bounds sibling flooding from the parent root", async () => {
    const root = tempRoot("siblings");
    const work = join(root, "work");
    for (let index = 0; index < 300; index += 1) mkdirSync(join(work, `sibling${index}`), { recursive: true });
    const result = await discoverDirectories({ cwd: join(work, "proj"), home: join(root, "home"), maxResults: 50 });
    expect(result.directories.length).toBeLessThanOrEqual(50);
    expect(result.truncated).toBe(true);
  });

  it("caps an oversized requested entry budget at the hard ceiling", async () => {
    const root = tempRoot("entry-ceiling");
    const cwd = join(root, "work", "proj");
    mkdirSync(cwd, { recursive: true });
    for (let index = 0; index < 4000; index += 1) writeFileSync(join(cwd, `f${index}.txt`), "x");
    // MAX_SAFE_INTEGER used to be accepted verbatim, i.e. an effectively unbounded scan.
    const result = await discoverDirectories({ cwd, home: join(root, "home"), maxEntries: Number.MAX_SAFE_INTEGER });
    expect(result.examined).toBeLessThanOrEqual(DEFAULT_PATH_INDEX_LIMITS.maxEntries + 1);
    expect(result.truncated).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it("enforces the time budget inside a single huge directory", async () => {
    const root = tempRoot("slow-directory");
    const cwd = join(root, "work", "proj");
    mkdirSync(cwd, { recursive: true });
    for (let index = 0; index < 4000; index += 1) writeFileSync(join(cwd, `f${index}.txt`), "x");
    // Deterministic clock: every Date.now() read advances 10ms, so the budget is exhausted
    // long before the entry budget. No wall-clock assertion is involved.
    let fakeNow = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      fakeNow += 10;
      return fakeNow;
    });
    try {
      const result = await discoverDirectories({ cwd, home: join(root, "home"), maxMs: 50 });
      expect(result.truncated).toBe(true);
      expect(result.aborted).toBe(false);
      // The scan entered the entry loop (examined > 0) and stopped on the clock there,
      // instead of draining the whole 3000-entry budget.
      expect(result.examined).toBeGreaterThan(0);
      expect(result.examined).toBeLessThan(100);
      expect(result.visited).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("skips known-project and root validation when the signal is already aborted", async () => {
    const ws = workspace();
    const elsewhere = tempRoot("pre-abort");
    const knownProjects = [1, 2, 3, 4, 5].map((index) => {
      const path = join(elsewhere, `group-${index}`, `known-${index}`);
      mkdirSync(path, { recursive: true });
      return path;
    });
    const controller = new AbortController();
    controller.abort();
    const result = await discoverDirectories({ cwd: ws.cwd, knownProjects, home: ws.home, signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.examined).toBe(0);
    expect(result.visited).toBe(0);
    // No lstat validation ran, so nothing was validated and nothing is retained.
    expect(result.known).toEqual([]);
    expect(result.directories).toEqual([]);
    expect(fsCalls.lstat).toBe(0);
  });

  it("retains already validated known projects when abort arrives mid-scan", async () => {
    const ws = workspace();
    const elsewhere = tempRoot("mid-abort");
    const legacy = join(elsewhere, "legacy-project");
    mkdirSync(legacy, { recursive: true });
    const controller = new AbortController();
    const result = await discoverDirectories({
      cwd: ws.cwd,
      knownProjects: [legacy],
      home: ws.home,
      signal: controller.signal,
      onDiscovered: () => controller.abort(),
    });
    expect(result.aborted).toBe(true);
    expect(result.known).toEqual([legacy]);
    expect(result.directories).toContain(legacy);
    expect(fsCalls.lstat).toBeGreaterThan(0);
  });

  it("uses documented default budgets", async () => {
    const ws = workspace();
    const result = await discoverDirectories({ cwd: ws.cwd, home: ws.home });
    expect(result.elapsedMs).toBeLessThan(DEFAULT_PATH_INDEX_LIMITS.maxMs + 500);
    expect(result.examined).toBeLessThanOrEqual(DEFAULT_PATH_INDEX_LIMITS.maxEntries);
    expect(result.directories.length).toBeLessThanOrEqual(DEFAULT_PATH_INDEX_LIMITS.maxResults);
    expect(result.visited).toBeLessThanOrEqual(DEFAULT_PATH_INDEX_LIMITS.maxRoots + DEFAULT_PATH_INDEX_LIMITS.maxQueue);
  });
});
