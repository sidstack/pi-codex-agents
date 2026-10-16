#!/usr/bin/env node
/** Host compatibility: an older host keeps serving, only a protocol bump blocks it. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureNativeConnection, connectNative, stopNativeHost } from "../dist/pi/client.js";
import { nativeDaemonPaths } from "../dist/core/host.js";
import { PROTOCOL_VERSION, VERSION } from "../dist/version.js";

const root = await mkdtemp(join(tmpdir(), "pi-host-compat-"));
const agent = join(root, "agent"), cwd = join(root, "work"), copied = join(root, "host-dist");
for (const directory of [agent, cwd]) await mkdir(directory);
await cp(new URL("../dist/", import.meta.url).pathname, copied, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_OFFLINE = "1";
process.env.PI_AGENTS_NATIVE_DIR = join(agent, "pi-agents", "host");
await writeFile(join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// The copied host reports the identity of a build that predates this checkout.
function writeHostIdentity({ version, protocol }) {
  return writeFile(join(copied, "version.js"), [
    `export const VERSION = ${JSON.stringify(version)};`,
    `export const BUILD_ID = "${"0".repeat(64)}";`,
    `export const PROTOCOL_VERSION = ${protocol};`,
    "",
  ].join("\n"));
}

function startCopiedHost() {
  const child = spawn(process.execPath, [join(copied, "host-entry.js"), cwd], {
    cwd, detached: true, stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PI_AGENTS_NATIVE_DAEMON: "1", PI_AGENTS_PI_ROOT: join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent") },
  });
  child.on("error", () => {});
  child.unref();
}

try {
  await writeHostIdentity({ version: "0.0.1-older", protocol: PROTOCOL_VERSION });
  startCopiedHost();
  await wait(2500);
  const client = await ensureNativeConnection(cwd, true, undefined, { autoUpdateHost: false });
  const status = await client.request("status");
  assert.equal(status.version, "0.0.1-older", "the older host must still be reachable");
  assert(client.hostNotice, "the frontend must report that the host predates this build");
  assert.match(client.hostNotice, /nothing was interrupted/);
  client.socket.destroy();
  await stopNativeHost();
  console.log("PASS host compatibility: an older host keeps serving when auto-update is declined");

  // Nothing unsettled and no attached frontend: the stale host is replaced by the build
  // the user installed, without asking.
  await writeHostIdentity({ version: "0.0.2-older", protocol: PROTOCOL_VERSION });
  startCopiedHost();
  await wait(2500);
  const probe = await connectNative(nativeDaemonPaths().socket);
  const stale = await probe.request("status");
  probe.socket.end();
  assert.equal(stale.version, "0.0.2-older");
  const replaced = await ensureNativeConnection(cwd, true);
  const fresh = await replaced.request("status");
  assert.notEqual(fresh.pid, stale.pid, "a settled stale host must be replaced by the installed build");
  assert.equal(fresh.version, VERSION, "the replacement runs this build");
  assert.match(replaced.hostNotice, /updated to the current build; nothing was running/);
  replaced.socket.destroy();
  await stopNativeHost();
  console.log("PASS host compatibility: a settled unattached host updates to the installed build");

  // A host that predates settledStop runs its own shutdown semantics, which recorded settled
  // sessions as stopped. It must be reported, never replaced silently.
  const hostSource = await readFile(join(copied, "core/host.js"), "utf8");
  assert(hostSource.includes('capabilities: ["settledStop", "safeUpdate"],'), "the current host advertises settledStop");
  await writeFile(join(copied, "core/host.js"), hostSource.replace('capabilities: ["settledStop", "safeUpdate"],', ''));
  await writeHostIdentity({ version: "0.0.3-older", protocol: PROTOCOL_VERSION });
  startCopiedHost();
  await wait(2500);
  const legacyProbe = await connectNative(nativeDaemonPaths().socket);
  const legacy = await legacyProbe.request("status");
  legacyProbe.socket.end();
  assert.equal(legacy.capabilities, undefined, "the simulated host predates settledStop");
  const kept = await ensureNativeConnection(cwd, true);
  const keptStatus = await kept.request("status");
  assert.equal(keptStatus.pid, legacy.pid, "a host without settled-restart support is never replaced automatically");
  assert.match(kept.hostNotice, /nothing was interrupted/);
  kept.socket.destroy();
  await stopNativeHost();
  console.log("PASS host compatibility: a host without settled-restart support is reported, not replaced");

  await writeHostIdentity({ version: "0.0.2-older", protocol: PROTOCOL_VERSION + 1 });
  startCopiedHost();
  await wait(2500);
  await assert.rejects(() => ensureNativeConnection(cwd, true), (error) => {
    assert.match(error.message, /speaks protocol 2; this build needs 1/);
    assert.match(error.message, /\/agents restart/);
    return true;
  });
  console.log("PASS host compatibility: an incompatible protocol is refused with the restart instruction");
} finally {
  try { const client = await connectNative(nativeDaemonPaths().socket); await client.request("stop"); client.socket.destroy(); } catch {}
  await wait(300);
  await rm(root, { recursive: true, force: true });
}
