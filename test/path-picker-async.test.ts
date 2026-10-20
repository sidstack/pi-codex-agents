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

/** Background discovery is replaced so no real home scan runs and every callback is timed by the test. */
const discovery = vi.hoisted(() => {
  const calls: DiscoveryOptions[] = [];
  const discoverDirectories = vi.fn((options: DiscoveryOptions) => {
    calls.push(options);
    // The scan never settles: every assertion below runs while it is still in flight.
    return new Promise<never>(() => {});
  });
  return { calls, discoverDirectories };
});

vi.mock("../src/ui/path-index.js", () => ({ discoverDirectories: discovery.discoverDirectories }));

/**
 * Every directory listing parks on a gate promise while armed, so the test decides when the
 * picker's `await listSubdirectories(...)` settles and can inject keystrokes mid-refresh.
 * Disarmed by default, so the tests that only need real listings are unaffected.
 */
const gate = vi.hoisted(() => {
  const state = { armed: false, calls: [] as string[] };
  let held: Promise<void> = Promise.resolve();
  let resolveHeld: () => void = () => {};
  const rearm = (): void => {
    held = new Promise<void>((resolve) => {
      resolveHeld = resolve;
    });
  };
  return {
    get armed(): boolean {
      return state.armed;
    },
    /** Directories whose listing entered the mock; the last one is parked mid-await. */
    get calls(): string[] {
      return state.calls;
    },
    hold: (): Promise<void> => (state.armed ? held : Promise.resolve()),
    arm: (): void => {
      state.armed = true;
      rearm();
    },
    /** Let every parked listing through, then hold the next one again. */
    release: (): void => {
      resolveHeld();
      rearm();
    },
    /** Stop holding listings; anything parked finishes. */
    disarm: (): void => {
      state.armed = false;
      resolveHeld();
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      if (!gate.armed) return actual.opendir(...args);
      gate.calls.push(String(args[0]));
      await gate.hold();
      return actual.opendir(...args);
    },
  };
});

const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const roots: string[] = [];

afterEach(() => {
  gate.disarm();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const settle = async (): Promise<void> => { await sleep(150); };

/** Mirrors CACHE_TTL_MS in src/ui/path-picker.ts, which the tests must not change. */
const LISTING_CACHE_TTL_MS = 2000;

/**
 * The picker caches a directory listing for CACHE_TTL_MS, so a second refresh of the same
 * directory would not open it at all. Only the clock is faked (Date, never timers), so real
 * setTimeout-based settling and the picker's own debounce keep working.
 */
const expireListingCache = (): void => { vi.advanceTimersByTime(LISTING_CACHE_TTL_MS + 500); };

/** Let whatever is parked finish, then hold the next listing again. */
const flush = async (): Promise<void> => { await sleep(50); gate.release(); await settle(); };

/** Wait until a listing started after `before` calls is parked inside the picker's await. */
const parked = async (before: number): Promise<void> => {
  for (let attempt = 0; gate.calls.length === before && attempt < 40; attempt++) await sleep(5);
  if (gate.calls.length === before) throw new Error("expected a refresh to park inside its listing await");
};

const candidates = (picker: PathPicker): PickerCandidate[] => (picker as unknown as { candidates: PickerCandidate[] }).candidates;

const candidateAt = (picker: PathPicker, index: number): PickerCandidate => {
  const candidate = candidates(picker)[index];
  if (!candidate) throw new Error(`missing candidate at index ${index}`);
  return candidate;
};

const selectedIndex = (picker: PathPicker): number => (picker as unknown as { selected: number }).selected;

const listedPaths = (picker: PathPicker): string[] => candidates(picker).map((candidate) => candidate.path);

const typeText = (picker: PathPicker, text: string): void => {
  for (const character of text) picker.handleInput(character);
};

/** The picker's own discovery call, with the captured abort signal and batch callback. */
const controlledCall = (index: number): { signal: AbortSignal; onDiscovered: (directories: readonly string[]) => void } => {
  const call = discovery.calls[index];
  if (!call?.signal || !call.onDiscovered) throw new Error("picker did not hand discovery a signal and onDiscovered callback");
  return { signal: call.signal, onDiscovered: call.onDiscovered };
};

function openPicker(cwd: string, projects: PickerProject[] = []): { picker: PathPicker; done: ReturnType<typeof vi.fn>; redraw: ReturnType<typeof vi.fn>; scanIndex: number } {
  const scanIndex = discovery.calls.length;
  const done = vi.fn();
  const redraw = vi.fn();
  return { picker: new PathPicker(projects, cwd, theme, redraw, done, () => 30, true), done, redraw, scanIndex };
}

/** Two prefix-ranked children plus one exact-basename directory found only by the background scan. */
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-picker-async-"));
  roots.push(root);
  for (const name of ["alpha", "alphabet"]) mkdirSync(join(root, name));
  return root;
}

const DISCOVERED_EXACT = "/tmp/known/alph";

describe("async discovery and picker input", () => {
  it("keeps the selected path when a higher-ranked discovery arrives for the same query", async () => {
    const root = tree();
    const { picker, done, scanIndex } = openPicker(root);
    try {
      await settle();
      typeText(picker, "alph");
      await settle();
      expect(candidateAt(picker, 0).path).toBe(join(root, "alpha"));
      picker.handleInput("\x1b[B"); // move the selection to the second candidate
      expect(selectedIndex(picker)).toBe(1);

      controlledCall(scanIndex).onDiscovered([DISCOVERED_EXACT]);
      await settle();

      // The listing really changed: exact basename scores 100 and now leads the list.
      expect(candidateAt(picker, 0).path).toBe(DISCOVERED_EXACT);
      // Same query: the selection follows the chosen path, not its old index.
      expect(candidateAt(picker, selectedIndex(picker)).path).toBe(join(root, "alphabet"));
      expect(done).not.toHaveBeenCalled();
    } finally { picker.dispose(); }
  });

  it("accepts the current selection on Enter while the scan and a refresh are still pending", async () => {
    const root = tree();
    const { picker, done, scanIndex } = openPicker(root);
    try {
      await settle();
      typeText(picker, "alph");
      await settle();
      picker.handleInput("\x1b[B");
      expect(candidateAt(picker, selectedIndex(picker)).path).toBe(join(root, "alphabet"));

      const call = controlledCall(scanIndex);
      expect(call.signal.aborted).toBe(false);
      // A discovery batch schedules a refresh that has not run yet...
      call.onDiscovered([DISCOVERED_EXACT]);
      // ...and Enter lands inside that debounce window with the scan still in flight.
      picker.handleInput("\r");
      await settle();

      expect(done).toHaveBeenCalledTimes(1);
      expect(done).toHaveBeenCalledWith(join(root, "alphabet"));
      // The pending refresh did run and re-ranked the list; the accepted path is still the selection.
      expect(listedPaths(picker)).toContain(DISCOVERED_EXACT);
      expect(call.signal.aborted).toBe(true);
    } finally { picker.dispose(); }
  });

  it("aborts the captured signal on Escape or dispose and ignores late discovery callbacks", async () => {
    const root = tree();

    const cancelled = openPicker(root);
    try {
      await settle();
      typeText(cancelled.picker, "alph");
      await settle();
      const before = listedPaths(cancelled.picker);
      const call = controlledCall(cancelled.scanIndex);

      cancelled.picker.handleInput("\x1b");

      expect(cancelled.done).toHaveBeenCalledWith(undefined);
      expect(call.signal.aborted).toBe(true);

      call.onDiscovered([DISCOVERED_EXACT, join(root, "gamma")]);
      await settle();

      expect(listedPaths(cancelled.picker)).toEqual(before);
      expect(selectedIndex(cancelled.picker)).toBe(0);
      expect(cancelled.done).toHaveBeenCalledTimes(1);
      expect(discovery.calls.length).toBe(cancelled.scanIndex + 1); // no scan restarts after a finished picker
    } finally { cancelled.picker.dispose(); }

    const disposed = openPicker(root);
    try {
      await settle();
      typeText(disposed.picker, "alph");
      await settle();
      const before = listedPaths(disposed.picker);
      const call = controlledCall(disposed.scanIndex);

      disposed.picker.dispose();

      expect(call.signal.aborted).toBe(true);

      call.onDiscovered([DISCOVERED_EXACT]);
      await settle();

      expect(listedPaths(disposed.picker)).toEqual(before);
      expect(disposed.done).not.toHaveBeenCalled();
      expect(discovery.calls.length).toBe(disposed.scanIndex + 1);
    } finally { disposed.picker.dispose(); }
  });
});

describe("keystrokes landing inside an in-flight refresh", () => {
  /** Two cold prefix-ranked children; the discovered path only ranks first after a merge. */
  const freshTree = (): string => {
    const root = mkdtempSync(join(tmpdir(), "pi-picker-async-parked-"));
    roots.push(root);
    for (const name of ["alpha", "alphabet"]) mkdirSync(join(root, name));
    return root;
  };

  /** A picker typing "alph" whose next listing can be parked mid-await. */
  async function openTyping(): Promise<{ root: string; picker: PathPicker; done: ReturnType<typeof vi.fn>; redraw: ReturnType<typeof vi.fn>; scanIndex: number }> {
    const root = freshTree();
    const opened = openPicker(root);
    await settle();
    typeText(opened.picker, "alph");
    await settle();
    expect(listedPaths(opened.picker)).toEqual([join(root, "alpha"), join(root, "alphabet")]);
    expect(selectedIndex(opened.picker)).toBe(0);
    return { root, ...opened };
  }

  it("keeps the selection moved during the await when Enter commits afterwards", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { root, picker, done, scanIndex } = await openTyping();
    try {
      expireListingCache(); // the next refresh must really re-open the directory
      gate.arm();
      const before = gate.calls.length;
      // A discovery batch re-ranks the same query, and its refresh parks mid-await.
      controlledCall(scanIndex).onDiscovered([DISCOVERED_EXACT]);
      await parked(before);

      picker.handleInput("\x1b[B"); // ↓ lands while the refresh is still computing
      expect(candidateAt(picker, selectedIndex(picker)).path).toBe(join(root, "alphabet"));

      gate.release();
      await settle();
      // The listing really changed: the discovered exact basename now leads it.
      expect(candidateAt(picker, 0).path).toBe(DISCOVERED_EXACT);
      // The commit honoured the mid-refresh ↓ instead of the pre-await anchor.
      expect(candidateAt(picker, selectedIndex(picker)).path).toBe(join(root, "alphabet"));

      picker.handleInput("\r");
      await flush(); // Enter restarts a refresh; let it finish so the choice can land

      expect(done).toHaveBeenCalledTimes(1);
      expect(done).toHaveBeenCalledWith(join(root, "alphabet"));
    } finally { gate.disarm(); picker.dispose(); }
  });

  for (const [label, close] of [["Escape", (picker: PathPicker) => picker.handleInput("\x1b")], ["dispose", (picker: PathPicker) => picker.dispose()]] as const) {
    it(`a refresh still in flight after ${label} neither mutates nor repaints`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { picker, done, redraw, scanIndex } = await openTyping();
      try {
        const beforeListing = listedPaths(picker);
        expireListingCache();
        gate.arm();
        const before = gate.calls.length;
        controlledCall(scanIndex).onDiscovered([DISCOVERED_EXACT, "/tmp/known/gamma"]);
        await parked(before);

        close(picker);
        const repaintsAtClose = redraw.mock.calls.length;
        if (label === "Escape") {
          expect(done).toHaveBeenCalledTimes(1);
          expect(done).toHaveBeenCalledWith(undefined);
        }

        gate.release(); // the parked listing now finishes, one refresh too late
        await settle();
        expect(listedPaths(picker)).toEqual(beforeListing);
        expect(selectedIndex(picker)).toBe(0);
        expect(redraw).toHaveBeenCalledTimes(repaintsAtClose); // no repaint of a closed picker
        expect(done).toHaveBeenCalledTimes(label === "Escape" ? 1 : 0);
        expect(discovery.calls.length).toBe(scanIndex + 1); // no scan restarts after a closed picker
      } finally { gate.disarm(); picker.dispose(); }
    });
  }
});
