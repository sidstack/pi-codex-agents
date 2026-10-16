import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const root = new URL("..", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
if (!pkg.repository?.url?.startsWith("https://github.com/") || pkg.repository.url.includes("OWNER")) throw new Error("Set the approved public repository URL before publishing.");
if (git("status", "--porcelain")) throw new Error("Publishing requires a clean committed tree.");
if (git("describe", "--tags", "--exact-match", "HEAD") !== `v${pkg.version}`) throw new Error("Version must match the current vVERSION release tag.");
console.log(`Release identity verified: ${pkg.name}@${pkg.version}`);
