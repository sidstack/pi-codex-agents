import { lstat, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
export const DEFAULT_PATH_INDEX_LIMITS = {
    maxDepth: 3,
    maxHomeDepth: 2,
    maxEntries: 3000,
    maxRoots: 8,
    maxResults: 200,
    maxQueue: 512,
    maxMs: 1000,
};
/** Hard ceiling for `maxEntries`, even when a caller asks for more. */
const MAX_ENTRIES_CEILING = DEFAULT_PATH_INDEX_LIMITS.maxEntries;
const KNOWN_PROJECT_LIMIT = 50;
const BATCH_YIELD = 8;
const SKIPPED_NAMES = new Set(["node_modules", "vendor", "build", "dist", "__pycache__", ".git", ".cache", ".venv"]);
function clamp(value, fallback, max) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return fallback;
    return Math.min(Math.max(0, Math.floor(value)), max);
}
function isSkipped(name) {
    return SKIPPED_NAMES.has(name) || name.startsWith(".");
}
function isFilesystemRoot(path) {
    return path === "/" || path === dirname(path);
}
async function isDirectory(path) {
    try {
        // lstat, not stat: a symlink must never qualify as a traversal root.
        return (await lstat(path)).isDirectory();
    }
    catch {
        return false;
    }
}
function yieldToEventLoop() {
    return new Promise((done) => setImmediate(done));
}
/**
 * Bounded asynchronous directory discovery for the fuzzy launcher.
 *
 * BFS over the cwd, its parent and a shallow pass over the home directory first, then any
 * remaining root budget goes to the known project directories and their parents. The filesystem root is never traversed, symlinks are
 * never followed, heavy trees are skipped (roots are validated with lstat so a symlinked
 * cwd, home or known project is skipped rather than followed), and every budget (entries,
 * results, queue, roots, time) stops the scan instead of throwing. Unreadable or vanished directories contribute
 * nothing. Aborting returns the partial result with `aborted: true`.
 */
export async function discoverDirectories(options) {
    const started = Date.now();
    const maxDepth = clamp(options.maxDepth, DEFAULT_PATH_INDEX_LIMITS.maxDepth, 6);
    const maxHomeDepth = clamp(options.maxHomeDepth, DEFAULT_PATH_INDEX_LIMITS.maxHomeDepth, 3);
    const maxEntries = clamp(options.maxEntries, DEFAULT_PATH_INDEX_LIMITS.maxEntries, MAX_ENTRIES_CEILING);
    const maxRoots = clamp(options.maxRoots, DEFAULT_PATH_INDEX_LIMITS.maxRoots, 32);
    const maxResults = clamp(options.maxResults, DEFAULT_PATH_INDEX_LIMITS.maxResults, 2000);
    const maxQueue = clamp(options.maxQueue, DEFAULT_PATH_INDEX_LIMITS.maxQueue, 4096);
    const maxMs = clamp(options.maxMs, DEFAULT_PATH_INDEX_LIMITS.maxMs, 30_000);
    const signal = options.signal;
    const cwd = resolve(options.cwd);
    const home = resolve(options.home ?? homedir());
    const knownProjects = (options.knownProjects ?? []).slice(0, KNOWN_PROJECT_LIMIT).map((path) => resolve(path));
    const queue = [];
    const roots = new Set();
    const pushRoot = (path, source, depth) => {
        if (roots.size >= maxRoots)
            return;
        // Never turn '/' (or any drive root) into a traversal root.
        if (isFilesystemRoot(path))
            return;
        if (roots.has(path))
            return;
        roots.add(path);
        let limit = source === "home" ? maxHomeDepth : maxDepth;
        // When home coincides with another root (e.g. home === dirname(cwd) for a repo
        // cloned directly into ~), the shared root must respect the shallower home limit.
        if (source !== "cwd" && path === home)
            limit = Math.min(limit, maxHomeDepth);
        queue.push({ path, depth, source, limit });
    };
    const parent = dirname(cwd);
    // A call that is already aborted must not touch the filesystem at all: no known-project
    // lstat validation and no root validation.
    if (signal?.aborted)
        return buildResult(started, new Map(), [], 0, 0, false, true);
    const knownChecks = await Promise.all(knownProjects.map(async (path) => {
        const isDir = await isDirectory(path);
        return { path, isDir, parentIsDir: isDir && (await isDirectory(dirname(path))) };
    }));
    const known = [];
    for (const check of knownChecks)
        if (check.isDir)
            known.push(check.path);
    // Reserve the nearby roots first: known projects used to consume two roots each,
    // so 3 known projects dropped the home root and 4 dropped the cwd-parent root.
    // Known roots only fill whatever root budget remains; known projects are still
    // retained in the result even when they never become traversal roots.
    const [cwdOk, parentOk, homeOk] = await Promise.all([isDirectory(cwd), isDirectory(parent), isDirectory(home)]);
    if (cwdOk)
        pushRoot(cwd, "cwd", 0);
    if (parentOk)
        pushRoot(parent, "parent", 0);
    if (home !== cwd && homeOk)
        pushRoot(home, "home", 0);
    for (const check of knownChecks) {
        if (!check.isDir)
            continue;
        pushRoot(check.path, "known", 0);
        if (check.parentIsDir)
            pushRoot(dirname(check.path), "known", 0);
    }
    // Validation may have been interrupted while its lstat calls were in flight.
    if (signal?.aborted)
        return buildResult(started, new Map(), known, 0, 0, false, true);
    const visited = new Set();
    const discovered = new Map();
    // The picker already offers the session cwd as "here", so the parent scan must not re-report it.
    const excluded = new Set([cwd]);
    let examined = 0;
    let opened = 0;
    let truncated = false;
    let aborted = false;
    while (queue.length > 0) {
        if (signal?.aborted) {
            aborted = true;
            break;
        }
        if (Date.now() - started >= maxMs) {
            truncated = true;
            break;
        }
        if (examined >= maxEntries || discovered.size >= maxResults || visited.size >= maxQueue) {
            truncated = true;
            break;
        }
        const item = queue.shift();
        if (!item || visited.has(item.path))
            continue;
        visited.add(item.path);
        const depthLimit = item.limit;
        // maxDepth is the deepest directory reported below a root: children at the limit are
        // reported but never opened, and a depth bound alone is not reported as truncation.
        const canReport = item.depth + 1 <= depthLimit;
        const canDescend = item.depth + 1 < depthLimit;
        let entries;
        try {
            entries = await opendir(item.path);
        }
        catch {
            continue;
        }
        opened += 1;
        const batch = [];
        for await (const entry of entries) {
            examined += 1;
            if (signal?.aborted) {
                aborted = true;
                break;
            }
            // A single directory with a huge listing must respect the time budget too, not only
            // the budget between directories.
            if (Date.now() - started >= maxMs) {
                truncated = true;
                break;
            }
            if (examined >= maxEntries || discovered.size >= maxResults) {
                truncated = true;
                break;
            }
            // Dirent metadata never follows links, so symlinks are skipped as well as files.
            if (entry.isSymbolicLink() || !entry.isDirectory())
                continue;
            if (isSkipped(entry.name))
                continue;
            const child = join(item.path, entry.name);
            if (excluded.has(child) || discovered.has(child) || !canReport)
                continue;
            discovered.set(child, item.depth + 1);
            batch.push(child);
            if (queue.length < maxQueue && canDescend)
                queue.push({ path: child, depth: item.depth + 1, source: item.source, limit: item.limit });
        }
        if (batch.length > 0)
            options.onDiscovered?.(batch);
        if (aborted || truncated)
            break;
        // Yield between small batches so the picker stays responsive while a scan runs.
        if (opened % BATCH_YIELD === 0)
            await yieldToEventLoop();
    }
    return buildResult(started, discovered, known, examined, opened, truncated, aborted);
}
function buildResult(started, discovered, known, examined, visited, truncated, aborted) {
    const directories = [...discovered.keys()];
    for (const path of known)
        if (!discovered.has(path))
            directories.push(path);
    directories.sort((a, b) => {
        const depthA = discovered.get(a) ?? Number.MAX_SAFE_INTEGER;
        const depthB = discovered.get(b) ?? Number.MAX_SAFE_INTEGER;
        if (depthA !== depthB)
            return depthA - depthB;
        return a.localeCompare(b);
    });
    return {
        directories,
        known: [...known],
        examined,
        visited,
        truncated,
        aborted,
        elapsedMs: Date.now() - started,
    };
}
//# sourceMappingURL=path-index.js.map