import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { privateDirectory, readPrivateJSON } from "./security.js";
import { writeNativeRegistry } from "./storage.js";

/** Drafts are durable private state, not part of repeated frontend snapshots. */
export class NativeDraftStore {
  private readonly saved = new Map<string, string>();
  private readonly directory: string;
  constructor(hostDirectory: string) {
    this.directory = join(hostDirectory, "drafts");
    privateDirectory(this.directory);
  }
  private path(id: string): string {
    return join(this.directory, `${createHash("sha256").update(id).digest("hex")}.json`);
  }
  load(id: string, inline?: string): string | undefined {
    if (inline !== undefined) return inline;
    const path = this.path(id);
    if (!existsSync(path)) return undefined;
    const draft = readPrivateJSON(path);
    if (typeof draft !== "string") throw new Error(`Invalid saved draft for session ${id}`);
    this.saved.set(id, draft);
    return draft;
  }
  save(id: string, draft: string | undefined): void {
    if (draft === undefined || this.saved.get(id) === draft) return;
    try { writeNativeRegistry(this.path(id), draft); }
    catch (error) { throw new Error(`Cannot save draft for session ${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    this.saved.set(id, draft);
  }
}
