import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname } from "node:path";

export const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

// Cached at module load: a running host keeps the identity of its loaded build.
// Hash executable modules so rebuilding without a version bump is detected too.
const directory = new URL(".", import.meta.url);
const hash = createHash("sha256").update(VERSION);
for (const name of readdirSync(directory, { recursive: true }).filter((name): name is string => typeof name === "string" && name.endsWith(extname(new URL(import.meta.url).pathname))).sort()) {
  hash.update(name).update(readFileSync(new URL(name, directory)));
}
export const BUILD_ID = hash.digest("hex");

/** The request/response contract between the frontend and the host. A host that speaks a
 * different protocol must be replaced; a host that only predates this build keeps running
 * the code it already loaded, so an update never interrupts a live session. */
export const PROTOCOL_VERSION = 1;
