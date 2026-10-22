import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, chmodSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
function owned(info) { return process.getuid === undefined || info.uid === process.getuid(); }
export const MAX_PRIVATE_JSON_BYTES = 16 * 1024 * 1024;
/** App state must not traverse a symlink or use another user's directory. */
export function privateDirectory(path) {
    const absolute = resolve(path);
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    const info = lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || !owned(info))
        throw new Error(`Unsafe pi-codex-agents state directory: ${absolute}`);
    if (realpathSync(absolute) !== absolute)
        throw new Error(`Symlinked pi-codex-agents state directory: ${absolute}`);
    chmodSync(absolute, 0o700);
}
export function privateAppend(path) {
    privateDirectory(dirname(path));
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || !owned(info) || info.nlink !== 1) {
        closeSync(fd);
        throw new Error(`Unsafe pi-codex-agents log: ${path}`);
    }
    fchmodSync(fd, 0o600);
    return fd;
}
export function assertManagedFile(root, path) {
    const base = realpathSync(root);
    const target = realpathSync(path);
    const diff = relative(base, target);
    const info = lstatSync(path);
    if (!diff || diff === ".." || diff.startsWith(`..${sep}`) || isAbsolute(diff) || info.isSymbolicLink() || !info.isFile() || !owned(info) || info.nlink !== 1) {
        throw new Error("Managed session history escaped private storage or is not an owned regular file");
    }
}
export function plainText(text) {
    // Names and paths are metadata, not terminal markup. Preserve printable Unicode.
    return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
export function readPrivateJSON(path) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || !owned(info) || info.nlink !== 1 || info.size > MAX_PRIVATE_JSON_BYTES)
        throw new Error(`Unsafe or oversized pi-codex-agents state file: ${path}`);
    return JSON.parse(readFileSync(path, "utf8"));
}
//# sourceMappingURL=security.js.map