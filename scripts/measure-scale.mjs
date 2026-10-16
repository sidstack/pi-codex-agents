#!/usr/bin/env node
/** Reproducible local-only measurements; not a performance guarantee. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { NativeSessionHost } from "../dist/core/sessions.js";
import { NativeHistoryScanner } from "../dist/features/history-source.js";
import { DEFAULT_CONFIG } from "../dist/config.js";

process.env.PI_OFFLINE = "1";
const root = await mkdtemp(join(tmpdir(), "pi-scale-"));
const agent = join(root, "agent"), cwd = join(root, "project");
await mkdir(agent); await mkdir(cwd);
await writeFile(join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
const terminal = () => ({ columns: 100, rows: 35, kittyProtocolActive: false,
  start() {}, stop() {}, write() {}, async drainInput() {}, moveBy() {}, hideCursor() {}, showCursor() {},
  clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} });
let host = new NativeSessionHost(agent, terminal, { ...DEFAULT_CONFIG, autoName: false }, []);
// Test-owned modes must not install 32 process signal handlers.
const prepare = (mode) => { mode.registerSignalHandlers = () => {}; };
host.prepareMode = prepare;
const render = process.argv.includes("--render");
const memory = () => { global.gc?.(); return Math.round(process.memoryUsage().heapUsed / 1048576 * 10) / 10; };
try {
  const started = performance.now();
  for (let i = 0; i < 32; i++) await host.create(cwd, false, undefined, { id: i ? `task-${i}` : "home" });
  const createdMs = Math.round(performance.now() - started);
  if (render) for (const row of host.sessions.values()) { await row.view.start(); row.view.ui.stop(); }
  const liveHeapMiB = memory();
  const saved = [...host.sessions.values()].map((row) => ({ id: row.id, name: row.name, sessionFile: row.sessionFile }));
  const stoppedAt = performance.now();
  for (const row of saved.slice(1)) await host.stop(row.id);
  assert.equal([...host.sessions.values()].filter((row) => row.runtime || row.view || row.mode || row.context || row.removeInput).length, 1);
  const stoppedHeapMiB = memory();
  const stopMs = Math.round(performance.now() - stoppedAt);
  await host.close();
  host = new NativeSessionHost(agent, terminal, { ...DEFAULT_CONFIG, autoName: false }, []);
  host.prepareMode = prepare;
  const restoredAt = performance.now();
  for (const row of saved) await host.create(cwd, false, undefined, row);
  const restoreMs = Math.round(performance.now() - restoredAt);
  const foreign = join(agent, "sessions", "foreign");
  await mkdir(foreign);
  const history = `${JSON.stringify({ type: "session", cwd })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(2000) } })}\n`;
  await Promise.all(Array.from({ length: 1000 }, (_, i) => writeFile(join(foreign, `${i}.jsonl`), history)));
  const scanner = new NativeHistoryScanner();
  const excluded = new Set(saved.map((row) => row.sessionFile));
  const scanAt = performance.now();
  const cold = await scanner.scan(join(agent, "sessions"), excluded);
  const historyColdMs = Math.round(performance.now() - scanAt);
  const warmAt = performance.now();
  const warm = await scanner.scan(join(agent, "sessions"), excluded);
  const historyWarmMs = Math.round(performance.now() - warmAt);
  assert.equal(cold.sessions.length, 1000); assert.equal(warm.sessions.length, 1000);
  assert.deepEqual(cold.issues, []); assert.deepEqual(warm.issues, []);
  scanner.clear();
  console.log(JSON.stringify({ node: process.version, histories: 1000, historyColdMs, historyWarmMs, sessions: 32, createMs: createdMs, restoreMs, stop31Ms: stopMs,
    liveHeapMiB, stoppedHeapMiB, retainedStoppedRuntimeReferences: 0, renderedViews: render ? 32 : 0 }));
} finally { await host.close(); await rm(root, { recursive: true, force: true }); }
