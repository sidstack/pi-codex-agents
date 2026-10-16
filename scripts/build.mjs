import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url);
// Clean generated output so removed wrapper entry points cannot remain executable.
rmSync(new URL("dist", root), { recursive: true, force: true });
const result = spawnSync(process.execPath, [new URL("node_modules/typescript/bin/tsc", root).pathname, "-p", "tsconfig.json"], { stdio: "inherit", cwd: root });
if (result.status !== 0) process.exit(result.status ?? 1);
const hash = createHash("sha256");
for (const name of readdirSync(new URL("src/", root), { recursive: true }).filter((name) => name.endsWith(".ts")).sort()) hash.update(name).update(readFileSync(new URL(`src/${name}`, root)));
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
mkdirSync(new URL("dist", root), { recursive: true });
writeFileSync(new URL("dist/build.json", root), JSON.stringify({ version, sourceHash: hash.digest("hex") }, null, 2) + "\n");
