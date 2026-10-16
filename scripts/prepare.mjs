import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url);
if (existsSync(new URL("node_modules/typescript/bin/tsc", root))) {
  const result = spawnSync(process.execPath, [new URL("scripts/build.mjs", root).pathname], { cwd: root, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else {
  // Pi's Git installer omits devDependencies. Git releases ship compiled modules.
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const build = JSON.parse(readFileSync(new URL("dist/build.json", root), "utf8"));
  if (build.version !== pkg.version || !existsSync(new URL("dist/extension.js", root)) || !existsSync(new URL("dist/host-entry.js", root))) throw new Error("Missing or outdated compiled extension; install a release tag or build with devDependencies.");
  if (existsSync(new URL("src/", root))) {
    const hash = createHash("sha256");
    for (const name of readdirSync(new URL("src/", root), { recursive: true }).filter((name) => name.endsWith(".ts")).sort()) hash.update(name).update(readFileSync(new URL(`src/${name}`, root)));
    if (hash.digest("hex") !== build.sourceHash) throw new Error("Compiled extension does not match source; run npm install with devDependencies and rebuild.");
  }
}
