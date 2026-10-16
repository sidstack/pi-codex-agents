import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { privateDirectory, readPrivateJSON } from "./security.js";
import { writeNativeRegistry } from "./storage.js";
/** Drafts are durable private state, not part of repeated frontend snapshots. */
export class NativeDraftStore {
    saved = new Map();
    directory;
    constructor(hostDirectory) {
        this.directory = join(hostDirectory, "drafts");
        privateDirectory(this.directory);
    }
    path(id) {
        return join(this.directory, `${createHash("sha256").update(id).digest("hex")}.json`);
    }
    load(id, inline) {
        if (inline !== undefined)
            return inline;
        const path = this.path(id);
        if (!existsSync(path))
            return undefined;
        const draft = readPrivateJSON(path);
        if (typeof draft !== "string")
            throw new Error(`Invalid saved draft for session ${id}`);
        this.saved.set(id, draft);
        return draft;
    }
    save(id, draft) {
        if (draft === undefined || this.saved.get(id) === draft)
            return;
        try {
            writeNativeRegistry(this.path(id), draft);
        }
        catch (error) {
            throw new Error(`Cannot save draft for session ${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        this.saved.set(id, draft);
    }
}
//# sourceMappingURL=drafts.js.map