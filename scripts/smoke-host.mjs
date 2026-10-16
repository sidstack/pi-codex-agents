#!/usr/bin/env node
/** Persistent native host, real SDK/model calls to a local fake server only. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ensureNativeConnection, connectNative } from "../dist/pi/client.js";
import { nativeDaemonPaths } from "../dist/core/host.js";

const root = await mkdtemp(join(tmpdir(), "pi-native-persist-"));
const agent = join(root, "agent"), alpha = join(root, "alpha");
await mkdir(agent); await mkdir(alpha);
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_OFFLINE = "1";
process.env.PI_AGENTS_NATIVE_DIR = join(agent, "pi-agents", "host");
const clients = [];
let owner;
const deadline = setTimeout(() => { if (owner) process.kill(owner, "SIGKILL"); console.error("FAIL daemon smoke deadline"); process.exit(1); }, 60000);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label) {
  for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await wait(25); }
  throw new Error(`Timed out: ${label}`);
}
let requests = 0;
const server = createServer(async (req, res) => {
  for await (const _chunk of req) {}
  requests++;
  await wait(500);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "persist", object: "chat.completion.chunk", created: 1, model: "native-smoke", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.write(chunk({ role: "assistant", content: "persistent-background-complete" }));
  res.write(chunk({}, "stop")); res.end("data: [DONE]\n\n");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
await mkdir(join(agent, "pi-agents"), { recursive: true });
await writeFile(join(agent, "pi-agents", "config.json"), JSON.stringify({ autoName: false }));
await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "native-smoke", defaultModel: "native-smoke", quietStartup: true }));
await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "native-smoke": {
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "local-only",
  models: [{ id: "native-smoke", name: "Native smoke", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
const attachedFields = { columns: 100, rows: 35, kitty: false };
const key = (client, data) => client.send({ type: "input", data, kitty: false });
async function client(start = false) {
  const c = start ? await ensureNativeConnection(alpha) : await connectNative(nativeDaemonPaths().socket);
  clients.push(c); return c;
}
function output(client) {
  let text = "";
  client.onEvent = (event) => { if (event.type === "terminal" && event.method === "write") text += event.args[0]; };
  return () => text;
}
try {
  const first = await client(true);
  owner = (await first.request("status")).pid;
  await first.request("attach", attachedFields);
  const observer = await client();
  await assert.rejects(observer.request("attach", attachedFields), /already attached/);
  await assert.rejects(observer.request("stop", { onlyIfSettled: true }), /frontend terminal is attached/,
    "an attachment appearing after an update probe must atomically prevent automatic stop");
  assert.equal((await observer.request("status")).pid, owner);
  await until(async () => !(await observer.request("status")).initializing, "native startup finishes");
  key(first, "test persistent native background execution"); key(first, "\r");
  await until(() => requests === 1, "local provider request starts");
  let state = await observer.request("status");
  assert.equal(state.sessions.find((r) => r.id === "home").running, true);
  await assert.rejects(() => observer.request("stop", { onlyIfSettled: true }), /1 session\(s\) are running or waiting/,
    "a build update may not stop a host that owns a run");
  first.socket.destroy();
  await until(async () => {
    state = await observer.request("status");
    return !state.attached && state.sessions.find((r) => r.id === "home").activity === "ready";
  }, "background run settles after frontend disconnect");
  assert.equal(state.pid, owner);
  assert.equal(state.sessions.find((r) => r.id === "home").unread, true);
  assert.equal(requests, 1);
  const text = output(observer);
  await observer.request("attach", attachedFields);
  await until(() => text().includes("persistent-background-complete"), "completed native transcript redraws after reattach");
  console.log("PASS native daemon: real model run survives frontend loss and reattaches without replay");

  key(observer, "draft-survives-takeover");
  const moved = await client(); const movedText = output(moved);
  await moved.request("attach", { ...attachedFields, takeover: true });
  await until(() => movedText().includes("draft-survives-takeover"), "draft survives takeover");
  assert.equal((await moved.request("status")).pid, owner);
  console.log("PASS native daemon: explicit terminal takeover preserves the runtime and editor draft");

  const sourceDir = join(agent, "sessions", "history-fixture");
  await mkdir(sourceDir, { recursive: true });
  const source = join(sourceDir, "saved.jsonl");
  const homeFile = (await moved.request("status")).sessions.find((r) => r.id === "home").sessionFile;
  await cp(homeFile, source);
  const sourceBefore = await readFile(source, "utf8");
  state = await moved.request("status");
  const saved = state.sessions.find((r) => r.activity === "inactive" && r.sourceFile === source);
  assert(saved);
  state = await moved.request("recover", { sessionId: saved.id });
  const recovered = state.sessions.find((r) => r.id === saved.id);
  const recoveredText = await readFile(recovered.sessionFile, "utf8");
  assert.notEqual(JSON.parse(recoveredText.split("\n")[0]).id, JSON.parse(sourceBefore.split("\n")[0]).id);
  assert.equal(await readFile(source, "utf8"), sourceBefore);
  assert.equal(requests, 1, "recovery must not start a model request");
  console.log("PASS native daemon: discovery recovers history with a new native ID and leaves the source untouched");

  // Crash only this isolated fixture host while it is running, then race two launches.
  key(moved, "second local request interrupted by simulated crash"); key(moved, "\r");
  await until(() => requests === 2, "second request starts");
  const beforeCrash = await moved.request("status");
  assert.equal(beforeCrash.sessions.find((r) => r.id === saved.id).running, true);
  process.kill(owner, "SIGKILL");
  await until(() => moved.socket.destroyed, "crashed host disconnects frontend");
  // Simulate a crash during the first write of the lock files, not just clean JSON.
  await writeFile(join(nativeDaemonPaths().directory, "host.lock"), "");
  await writeFile(`${nativeDaemonPaths().registry}.lock`, "{");
  const [restart, competitor] = await Promise.all([client(true), client(true)]);
  state = await restart.request("status");
  owner = state.pid;
  assert.equal((await competitor.request("status")).pid, owner);
  assert.notEqual(state.pid, beforeCrash.pid);
  const restored = state.sessions.find((r) => r.id === saved.id);
  assert.equal(restored.sessionFile, recovered.sessionFile);
  assert.equal(restored.activity, "failed");
  assert.match(restored.lastError, /Previous host ended/);
  assert.equal(state.sessions.filter((r) => r.sourceFile === source).length, 1);
  await wait(200);
  assert.equal(requests, 2, "crash recovery must not silently replay a model request");
  console.log("PASS native daemon: crash recovery preserves native identity, flags interrupted work, and concurrent launches share one owner");
  // A settled session must survive a host restart as itself, not as an explicit stop.
  const gamma = join(root, "gamma");
  await mkdir(gamma);
  await restart.request("attach", attachedFields);
  await restart.request("open");
  await wait(400);
  key(restart, "\x10");                       // Ctrl+P in the command center: choose a directory
  await wait(600);
  key(restart, gamma);
  await wait(300);
  key(restart, "\r");
  await wait(1500);
  const gammaId = (await restart.request("status")).sessions.find((row) => row.cwd === gamma)?.id;
  assert(gammaId, "command center created a settled session");
  await restart.request("stop");
  await until(() => restart.socket.destroyed, "explicit stop closes host");
  const registry = JSON.parse(await readFile(nativeDaemonPaths().registry, "utf8"));
  const savedRow = (id) => registry.sessions.find((row) => row.id === id);
  assert.equal(savedRow(gammaId).activity, "ready", "a settled session must stay restorable, not become an explicit stop");
  assert.equal(savedRow(saved.id).activity, "failed", "an interrupted run stays interrupted");
  assert(registry.sessions.filter((row) => row.sessionFile).every((row) => row.activity !== "stopped"),
    "host shutdown must not relabel every session as stopped");
  console.log("PASS native daemon: host shutdown aborts runs without relabeling settled sessions as stopped");

  const afterStop = await client(true);
  state = await afterStop.request("status"); owner = state.pid;
  assert.equal(state.sessions.find((row) => row.id === gammaId).activity, "ready");
  const restoredSaved = state.sessions.find((row) => row.id === saved.id);
  assert.equal(restoredSaved.activity, "failed");
  assert.equal(restoredSaved.sessionFile, recovered.sessionFile, "restored sessions reopen their own managed history");
  assert.equal(requests, 2, "host restart must not replay a model request");
  console.log("PASS native daemon: host restart restores settled sessions live from their own history");

  await afterStop.request("stop");
  await until(() => afterStop.socket.destroyed, "stop before restoration fixtures");
  const damaged = JSON.parse(await readFile(nativeDaemonPaths().registry, "utf8"));
  const damagedGamma = damaged.sessions.find((row) => row.id === gammaId);
  await rm(gamma, { recursive: true });
  damagedGamma.activity = "ready";
  const home = damaged.sessions.find((row) => row.id === "home");
  const missingHome = home.sessionFile;
  await rm(missingHome);
  const bigDraft = "durable-draft ".repeat(400000);
  const draftDir = join(nativeDaemonPaths().directory, "drafts");
  await writeFile(join(draftDir, `${createHash("sha256").update(gammaId).digest("hex")}.json`), JSON.stringify(bigDraft), { mode: 0o600 });
  await writeFile(nativeDaemonPaths().registry, JSON.stringify(damaged), { mode: 0o600 });
  const repaired = await client(true);
  state = await repaired.request("status"); owner = state.pid;
  const broken = state.sessions.find((row) => row.id === gammaId);
  assert.equal(broken.activity, "failed");
  assert.match(broken.lastError, /directory|ENOENT|cwd/i);
  assert.equal(broken.sessionFile, damagedGamma.sessionFile);
  assert.equal(state.sessions.find((row) => row.id === "home").activity, "ready");
  assert(state.sessions.some((row) => row.name === "Previous Home" && row.sessionFile === missingHome && row.activity === "failed"));
  assert(state.sessions.find((row) => row.id === saved.id).sessionFile === recovered.sessionFile,
    "a broken neighboring history must not prevent healthy restoration");
  assert(!JSON.stringify(state).includes("durable-draft"), "status carries metadata, not editor contents");
  assert(Buffer.byteLength(JSON.stringify(state)) < 65536);
  await mkdir(gamma);
  await repaired.request("attach", attachedFields);
  state = await repaired.request("recover", { sessionId: gammaId });
  assert.equal(state.activeId, gammaId, "retry after repairing cwd must reopen the failed session");
  assert.equal(state.sessions.find((row) => row.id === gammaId).sessionFile, damagedGamma.sessionFile);
  await repaired.request("stop");
  await until(() => repaired.socket.destroyed, "stop after draft recovery");
  assert.equal(JSON.parse(await readFile(join(draftDir, `${createHash("sha256").update(gammaId).digest("hex")}.json`), "utf8")), bigDraft);
  assert.equal(requests, 2, "restoration and failed-session retry never replay a request");
  console.log("PASS native daemon: missing Home, deleted cwd, healthy restoration, retry, and 5 MiB drafts remain recoverable");

  // A global extension can need input during native initialization. The socket
  // must already be reachable, and concurrent attachment must share that init.
  await mkdir(join(agent, "extensions"), { recursive: true });
  await writeFile(join(agent, "extensions", "startup-dialog.ts"), `export default function(pi) {
    pi.on("session_start", async (_event, ctx) => { await ctx.ui.confirm("Fixture startup dialog", "Continue startup?"); });
  }`);
  const startup = await client(true);
  owner = (await startup.request("status")).pid;
  await until(async () => (await startup.request("status")).sessions.some((row) => row.prompts > 0), "startup dialog is reachable before initialization finishes");
  const startupText = output(startup);
  await startup.request("attach", attachedFields);
  await until(() => startupText().includes("Fixture startup dialog"), "startup dialog renders on attachment");
  key(startup, "\x1b");
  await until(async () => !(await startup.request("status")).initializing, "startup completes after cancelling its dialog");
  console.log("PASS native daemon: startup extension dialogs remain attachable and cancellable");
} finally {
  for (const c of clients) c.socket.destroy();
  try { const stop = await connectNative(nativeDaemonPaths().socket); await stop.request("stop"); stop.socket.destroy(); } catch {}
  await wait(150);
  if (owner) { try { process.kill(owner, "SIGKILL"); } catch {} }
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
  clearTimeout(deadline);
}
