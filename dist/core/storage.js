import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_PRIVATE_JSON_BYTES, privateDirectory } from "./security.js";
export function processIdentity(pid = process.pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    catch {
        return undefined;
    }
}
/** Exclusive lock with PID-reuse protection. Never reclaim a live owner's lock. */
export function acquireNativeLock(path) {
    privateDirectory(dirname(path));
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const fd = openSync(path, "wx", 0o600);
            try {
                writeFileSync(fd, JSON.stringify({ pid: process.pid, identity: processIdentity() }));
            }
            finally {
                closeSync(fd);
            }
            return () => { try {
                unlinkSync(path);
            }
            catch { } };
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            let owner;
            try {
                owner = JSON.parse(readFileSync(path, "utf8"));
            }
            catch {
                throw new Error(`Native lock is incomplete: ${path}`);
            }
            if (Number.isInteger(owner.pid) && owner.identity && processIdentity(owner.pid) === owner.identity) {
                throw new Error(`Native host already owns ${path} (PID ${owner.pid})`);
            }
            try {
                unlinkSync(path);
            }
            catch { }
        }
    }
    throw new Error(`Could not acquire native lock: ${path}`);
}
export function writeNativeRegistry(path, value, maxBytes = MAX_PRIVATE_JSON_BYTES) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(text) > maxBytes)
        throw new Error(`State exceeds the ${maxBytes}-byte limit at ${path}; previous state was preserved`);
    const release = acquireNativeLock(`${path}.lock`);
    const temporary = `${path}.tmp-${randomUUID()}`;
    try {
        const fd = openSync(temporary, "wx", 0o600);
        try {
            writeFileSync(fd, text);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(temporary, path);
    }
    finally {
        try {
            unlinkSync(temporary);
        }
        catch { }
        release();
    }
}
//# sourceMappingURL=storage.js.map