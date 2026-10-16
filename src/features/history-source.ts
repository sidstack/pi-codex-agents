import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createJsonlReader, isParseError } from "../core/jsonl.js";

export interface SavedNativeSession { id: string; name: string; cwd: string; sourceFile: string; modified: string; }
export interface HistoryDiscovery { sessions: SavedNativeSession[]; issues: string[]; }
export interface HistoryScanLimits { entries: number; bytes: number; fileBytes: number; recordBytes: number; metadataBytes: number; }
const LIMITS: HistoryScanLimits = { entries: 10000, bytes: 32 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, recordBytes: 1024 * 1024, metadataBytes: 512 * 1024 };
interface CachedHistory { modified: number; size: number; session?: SavedNativeSession; issues: string[]; }

/** Read-only, bounded discovery. One cache belongs to one feature/host lifetime. */
export class NativeHistoryScanner {
  private readonly cache = new Map<string, CachedHistory>();
  private readonly limits: HistoryScanLimits;
  constructor(limits: Partial<HistoryScanLimits> = {}) { this.limits = { ...LIMITS, ...limits }; }
  clear(): void { this.cache.clear(); }
  async scan(base: string, excluded: ReadonlySet<string> = new Set()): Promise<HistoryDiscovery> {
    const sessions: SavedNativeSession[] = [], issues: string[] = [];
    const seen = new Set<string>();
    const skip = new Set([...excluded].map((path) => resolve(path)));
    let visited = 0, remaining = this.limits.bytes, entryLimit = false, byteLimit = false;
    const issue = (path: string, error: unknown) => {
      if (issues.length < 100) issues.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    };
    const read = async (path: string): Promise<void> => {
      if (skip.has(resolve(path))) return;
      const canonical = await realpath(path);
      if (skip.has(canonical) || seen.has(canonical)) return;
      seen.add(canonical);
      const info = await stat(canonical);
      const cached = this.cache.get(canonical);
      if (cached && cached.modified === info.mtimeMs && cached.size === info.size) {
        if (cached.session) sessions.push(cached.session);
        for (const message of cached.issues) issue(canonical, message);
        return;
      }
      if (!remaining) { byteLimit = true; return; }
      let cwd: string | undefined, name: string | undefined, hasUser = false;
      const fileIssues: string[] = [];
      const budget = Math.min(info.size, this.limits.fileBytes, remaining);
      if (budget < info.size) fileIssues.push(`Partial discovery: read budget ${budget} of ${info.size} bytes`);
      const reader = createJsonlReader((raw) => {
        if (isParseError(raw)) { if (!fileIssues.includes("Malformed or oversized history record")) fileIssues.push("Malformed or oversized history record"); return; }
        if (!raw || typeof raw !== "object") return;
        const record = raw as { type?: string; cwd?: unknown; name?: unknown; message?: { role?: string } };
        if (record.type === "session" && typeof record.cwd === "string" && record.cwd.startsWith("/")) cwd = record.cwd;
        if (record.type === "session_info" && typeof record.name === "string") name = record.name.slice(0, 200);
        if (record.type === "message" && record.message?.role === "user") hasUser = true;
      }, this.limits.recordBytes);
      if (budget) {
        const stream = createReadStream(canonical, { highWaterMark: 16384, end: budget - 1 });
        try { for await (const chunk of stream) { remaining -= (chunk as Buffer).byteLength; reader.write(chunk as Buffer); } }
        finally { stream.destroy(); }
      }
      // Do not flush an unfinished final record from a concurrent Pi writer.
      const session = cwd && hasUser ? {
        id: `saved:${createHash("sha256").update(canonical).digest("hex").slice(0, 20)}`,
        name: name || `Saved ${basename(cwd)} · ${info.mtime.toISOString().slice(0, 16).replace("T", " ")}`,
        cwd, sourceFile: canonical, modified: info.mtime.toISOString(),
      } : undefined;
      // Aggregate truncation must be retried next refresh, rather than caching a
      // result that depends on other files' budget consumption.
      if (budget === Math.min(info.size, this.limits.fileBytes)) this.cache.set(canonical, { modified: info.mtimeMs, size: info.size, session, issues: fileIssues });
      else byteLimit = true;
      if (session) sessions.push(session);
      for (const message of fileIssues) issue(canonical, message);
    };
    const visit = async (directory: string): Promise<void> => {
      try {
        const entries = await opendir(directory);
        for await (const entry of entries) {
          if (++visited > this.limits.entries) { entryLimit = true; break; }
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await visit(path);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            try { await read(path); } catch (error) { issue(path, error); }
          }
          if (entryLimit) break;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || directory !== base) issue(directory, error); }
    };
    await visit(base);
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
    if (entryLimit) issue(base, `Partial discovery: exceeded ${this.limits.entries} directory entries`);
    if (byteLimit) issue(base, `Partial discovery: exhausted ${this.limits.bytes}-byte scan budget`);
    const visible: SavedNativeSession[] = [];
    let metadataBytes = 0;
    for (const session of sessions.sort((a, b) => b.modified.localeCompare(a.modified))) {
      metadataBytes += Buffer.byteLength(JSON.stringify(session));
      if (metadataBytes > this.limits.metadataBytes) {
        const message = `${base}: Partial discovery: exceeded ${this.limits.metadataBytes}-byte metadata budget`;
        if (issues.length >= 100) issues[99] = message; else issues.push(message);
        break;
      }
      visible.push(session);
    }
    return { sessions: visible, issues };
  }
}

/** Convenience for one-off callers; hosts retain their scanner instance. */
export async function discoverNativeHistory(base: string): Promise<SavedNativeSession[]> {
  return (await new NativeHistoryScanner().scan(base)).sessions;
}
