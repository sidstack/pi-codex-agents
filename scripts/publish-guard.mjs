import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const root = new URL("..", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
if (!pkg.repository?.url?.startsWith("https://github.com/") || pkg.repository.url.includes("OWNER")) throw new Error("Set the approved public repository URL before publishing.");
if (git("status", "--porcelain")) throw new Error("Publishing requires a clean committed tree.");
const build = JSON.parse(readFileSync(new URL("dist/build.json", root), "utf8"));
if (build.version !== pkg.version) throw new Error(`Compiled build metadata is ${build.version} while package.json is ${pkg.version}; rebuild generated modules before publishing.`);
// semantic-release creates the vVERSION tag on the release commit before publish plugins run,
// so the same identity rule holds for automated and interactive publishes.
let tag = "";
try {
  tag = git("describe", "--tags", "--exact-match", "HEAD");
} catch {
  tag = "";
}
if (tag !== `v${pkg.version}`) throw new Error("Version must match the current vVERSION release tag.");
console.log(`Release identity verified: ${pkg.name}@${pkg.version}`);
