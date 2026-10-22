import { mkdtempSync, readFileSync, rmSync, readdirSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url);
const temp = mkdtempSync(join(tmpdir(), "pi-codex-agents-install-"));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.error}`);
};
try {
  run("npm", ["pack", "--pack-destination", temp]);
  const tarball = join(temp, readdirSync(temp).find((name) => name.endsWith(".tgz")));
  const pi = join(temp, "pi"); mkdirSync(pi);
  // A separate real Pi installation, with no module lookup into the checkout.
  run("npm", ["install", "--prefix", pi, "--no-audit", "--no-fund", "--package-lock=false", "@earendil-works/pi-coding-agent@1.4.0"]);
  const cli = join(pi, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  run("python3", ["scripts/smoke-extension.py"], { env: { ...process.env, PI_CODEX_AGENTS_TEST_TARBALL: tarball, PI_CODEX_AGENTS_TEST_PI_CLI: cli } });

  // Reproduce the Git installer's omit-dev behavior using an independent source
  // copy: no compiler, no SDK peers, and no lifecycle dependency on the checkout.
  const git = join(temp, "git-package"); mkdirSync(git);
  for (const name of ["package.json", "package-lock.json", "src", "dist", "scripts"]) cpSync(new URL(name, root), join(git, name), { recursive: true });
  run("npm", ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: git });
  if (existsSync(join(git, "node_modules/typescript"))) throw new Error("Git fixture unexpectedly installed TypeScript");
  const { version } = JSON.parse(readFileSync(join(git, "dist/build.json"), "utf8"));
  if (!version) throw new Error("Missing Git build manifest");
  console.log("PASS Git install preparation: shipped modules validate without compiler or SDK peers");
} finally { rmSync(temp, { recursive: true, force: true }); }
