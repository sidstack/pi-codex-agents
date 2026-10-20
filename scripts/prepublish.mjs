import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url);
const automated = process.env.PI_AUTOMATED_PUBLISH === "true";

// Automated publishes come from the publish workflow, whose check job already ran the full
// release gate on this exact commit before semantic-release versioned and tagged it.
// Rebuilding it here would duplicate minutes of work inside `npm publish`.
if (!automated) {
  const gate = spawnSync("npm", ["run", "release:check"], { cwd: root, stdio: "inherit", shell: false });
  if (gate.status !== 0) process.exit(gate.status ?? 1);
}

const guard = spawnSync(process.execPath, [new URL("scripts/publish-guard.mjs", root).pathname], { cwd: root, stdio: "inherit" });
process.exit(guard.status ?? 1);
