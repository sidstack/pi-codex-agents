#!/usr/bin/env node
/** Real Pi 1.3.0 native views; fake terminal and local deterministic model. No paid tokens. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../dist/config.js";
import { configuredFeatures } from "../dist/features/index.js";
import { NativeSessionHost } from "../dist/core/sessions.js";

process.env.PI_OFFLINE = "1";
const root = await mkdtemp(join(tmpdir(), "pi-agents-native-smoke-"));
const deadline = setTimeout(() => { console.error("FAIL native smoke deadline (45s)"); process.exit(1); }, 45_000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label) {
  for (let i = 0; i < 200; i++) { if (check()) return; await wait(25); }
  throw new Error(`Timed out: ${label}`);
}
function pass(label) { console.log(`PASS ${label}`); }

class FakeTerminal {
  columns = 100; rows = 40; kittyProtocolActive = false; writes = []; starts = 0; active = false;
  start(input, resize) { this.input = input; this.resize = resize; this.starts++; this.active = true; }
  stop() { this.active = false; }
  async drainInput() {}
  write(data) { this.writes.push(data); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle() {} setProgress() {} setProgramStatus() {}
  key(data) { assert(this.active, "input must have an active terminal"); this.input(data); }
}
let requests = 0;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  requests++;
  await wait(350);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1, model: "native-smoke", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  if (body.includes("cancel-tool-dialog")) {
    res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "stop-dialog-1", type: "function", function: { name: "stop_dialog", arguments: "{}" } }] }));
    res.write(chunk({}, "tool_calls"));
  } else {
    res.write(chunk({ role: "assistant", content: "native-background-complete" }));
    res.write(chunk({}, "stop"));
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const agentDir = join(root, "agent");
const todoExtension = process.env.PI_AGENTS_TODO_EXTENSION;
await mkdir(agentDir);
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "native-smoke", defaultModel: "native-smoke", quietStartup: true, tui: { mode: "fullscreen" }, ...(todoExtension ? { extensions: [todoExtension] } : {}) }));
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "native-smoke": {
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "local-only",
  models: [{ id: "native-smoke", name: "Native smoke", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
const terminals = [];
const host = new NativeSessionHost(agentDir, () => { const t = new FakeTerminal(); terminals.push(t); return t; }, DEFAULT_CONFIG, configuredFeatures(DEFAULT_CONFIG));
let coreHost;
try {
  const alpha = join(root, "alpha"), beta = join(root, "beta");
  for (const cwd of [alpha, beta]) {
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(join(cwd, ".pi", "extensions", "fixture.ts"), `import { Type } from "typebox";
    export default function(pi) {
      pi.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt.startsWith("cancel-before-start ")) return;
        const kind = event.prompt.split(" ")[1];
        if (kind === "custom") await ctx.ui.custom(() => ({ render: () => ["pending cancellation"], invalidate() {} }));
        else if (kind === "confirm") await ctx.ui.confirm("pending cancellation", "Continue?");
        else if (kind === "select") await ctx.ui.select("pending cancellation", ["Approve"]);
        else if (kind === "editor") await ctx.ui.editor("pending cancellation");
        else await ctx.ui.input("pending cancellation");
      });
      pi.registerTool({ name: "stop_dialog", label: "Stop dialog", description: "Cancellation fixture", parameters: Type.Object({}),
        execute: async (_id, _params, _signal, _update, ctx) => {
          const approved = await ctx.ui.confirm("pending tool cancellation", "Approve?");
          if (approved) throw new Error("Cancellation must never approve the tool");
          return { content: [{ type: "text", text: "cancelled" }], details: {} };
        }
      });
      pi.on("session_start", (_e, ctx) => ctx.ui.setWidget("native-proof", ["widget:" + ctx.cwd]));
      pi.registerCommand("native-dialog", { description: "Smoke dialog", handler: async (_args, ctx) => {
        const yes = await ctx.ui.confirm("native-dialog-proof", "Continue?");
        ctx.ui.setEditorText(yes ? "dialog-accepted" : "dialog-cancelled");
      }});
    }`);
  }
  const a = await host.create(alpha, true, undefined, { id: "home", name: "Home" });
  const seedTodo = (row, subject) => row.runtime.session.sessionManager.appendCustomEntry("rpiv-todo-state", {
    nextId: 2, tasks: [{ id: 1, subject, description: "Native widget smoke fixture", status: "pending", blockedBy: [], createdAt: Date.now(), updatedAt: Date.now() }],
  });
  if (todoExtension) seedTodo(a, "TODO_ALPHA_NATIVE_PROOF");
  a.view.lease.enabled = true;
  await a.view.start();
  host.startFeatures();
  const b = await host.create(beta, true);
  if (todoExtension) seedTodo(b, "TODO_BETA_NATIVE_PROOF");
  pass("two real native runtimes with distinct session files");
  assert.notEqual(a.runtime.session.sessionFile, b.runtime.session.sessionFile);
  a.context.ui.setEditorText("alpha draft");
  await host.activate(b.id);
  b.context.ui.setEditorText("beta draft");
  await host.activate(a.id);
  if (todoExtension) {
    await until(() => terminals[0].writes.join("").includes("TODO_ALPHA_NATIVE_PROOF"), "actual Todo widget in alpha");
    await host.activate(b.id);
    await until(() => terminals[1].writes.join("").includes("TODO_BETA_NATIVE_PROOF"), "actual Todo widget in beta");
    await host.activate(a.id);
    pass("installed rpiv-todo component widgets render in both native sessions");
  }
  assert.equal(a.context.ui.getEditorText(), "alpha draft");
  assert.equal(b.context.ui.getEditorText(), "beta draft");
  assert.equal(terminals.filter((t) => t.active).length, 1);
  pass("native editor drafts survive terminal handoff; only one terminal reads input");
  for (const [columns, rows] of [[40, 12], [120, 40], [200, 60]]) {
    for (const terminal of terminals) { terminal.columns = columns; terminal.rows = rows; if (terminal.active) terminal.resize?.(); }
    await host.activate(b.id); await host.activate(a.id);
    assert.equal(terminals.filter((terminal) => terminal.active).length, 1);
    assert.equal(a.context.ui.getEditorText(), "alpha draft");
    assert.equal(b.context.ui.getEditorText(), "beta draft");
  }
  pass("native switching preserves drafts and one terminal owner across three terminal geometries");

  const run = a.runtime.session.prompt("Return a short test response");
  await until(() => requests === 1, "local provider called");
  await host.activate(b.id);
  assert(a.running, "hidden alpha must continue running");
  const writes = terminals[0].writes.length;
  await run;
  assert.equal(a.activity, "ready");
  assert.equal(a.unread, true);
  assert.equal(terminals[0].writes.length, writes, "hidden view must not write to terminal");
  await host.activate(a.id);
  assert.equal(a.unread, false);
  await wait(50);
  assert(terminals[0].writes.join("").includes("native-background-complete"));
  pass("real model run finishes while hidden; native transcript restored without replay");

  const bash = await b.runtime.session.executeBash("pwd");
  assert(bash.output.includes(beta));
  pass("native bash uses the session cwd");

  a.context.ui.setEditorText("");
  terminals[0].key("/native-dialog"); terminals[0].key("\r");
  await until(() => a.activity === "waiting", "native dialog opens");
  terminals[0].key("\x1b[110;7u"); // Kitty Ctrl+Alt+N, intercepted even over a dialog.
  await until(() => host.activeId === b.id, "cycle away from dialog");
  assert.equal(a.activity, "waiting");
  terminals[1].key("\x1b[112;7u");
  await until(() => host.activeId === a.id, "cycle back to dialog");
  terminals[0].key("\r");
  await until(() => a.context.ui.getEditorText() === "dialog-accepted", "native dialog resolves");
  pass("pending native extension dialog survives switching away and back");

  terminals[0].key("\x07");
  await until(() => terminals[0].writes.join("").includes("Agent command center"), "Ctrl+G overlay");
  terminals[0].key("\x1b");
  await wait(25);
  pass("Ctrl+G opens and closes the native command center");

  const before = a.runtime.session.sessionId;
  const replacement = await a.runtime.newSession();
  assert.equal(replacement.cancelled, true);
  assert.equal(a.runtime.session.sessionId, before);
  pass("native destructive session replacement is blocked");
  await b.runtime.session.prompt("Investigate native terminal ownership");
  await until(() => b.name === "native-background-complete", "first-message generated name");
  assert.equal(b.context.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1,
    "naming must not add a user turn");
  pass("optional naming uses the configured provider and preserves native conversation turns");
  await host.stop(b.id);
  assert.equal(b.activity, "stopped");
  assert.equal(a.activity, "ready");
  pass("explicit stop disposes only the selected child");

  await host.close();
  const disabled = { ...DEFAULT_CONFIG, delegation: false, autoName: false, historyImport: false, commandCenterShortcut: false,
    leftArrowEntry: false, sessionCycling: false, showStatus: false, autoInactive: false };
  const coreTerminals = [];
  coreHost = new NativeSessionHost(agentDir, () => { const terminal = new FakeTerminal(); coreTerminals.push(terminal); return terminal; }, disabled, []);
  const home = await coreHost.create(alpha, true, undefined, { id: "home", name: "Home" });
  home.view.lease.enabled = true;
  await home.view.start();
  const child = await coreHost.create(beta, true);
  home.context.ui.setEditorText("core-only-draft");
  await coreHost.activate(child.id);
  await coreHost.activate(home.id);
  assert.equal(home.context.ui.getEditorText(), "core-only-draft");
  await coreHost.refreshFeatures();
  assert.equal(coreHost.sessions.size, 2, "Disabled import must not add ordinary histories");
  // With entry shortcuts disabled the command center is reachable only through
  // the registered /agents command, which is exactly what the core must keep.
  void coreHost.open(home.context);
  await until(() => coreTerminals[0].writes.join("").includes("Agent command center"), "core-only /agents command");
  coreTerminals[0].key("\x1b");
  await until(() => coreHost.activeId === home.id, "core-only board closes");
  await coreHost.deactivateIdle(Date.now() + 1_000_000);
  assert(child.view, "Disabled inactivity must preserve idle views");
  await coreHost.stop(child.id);
  assert.equal(child.activity, "stopped");
  pass("core remains usable with every optional feature disabled: /agents, creation, switching, drafts, and stop");

  for (const kind of ["confirm", "select", "input", "editor", "custom", "tool"]) {
    const pending = await coreHost.create(beta, true);
    await coreHost.activate(pending.id);
    const run = pending.runtime.session.prompt(kind === "tool" ? "cancel-tool-dialog" : `cancel-before-start ${kind}`);
    await until(() => pending.prompts > 0, `${kind} dialog opens`);
    await coreHost.activate(home.id);
    let stopped = false;
    const stop = coreHost.stop(pending.id).then(() => { stopped = true; });
    await until(() => stopped, `${kind} dialog cancellation lets hidden session stop`);
    await Promise.all([run, stop]);
    assert.equal(pending.activity, "stopped");
    assert.equal(pending.view, undefined);
    assert.equal(pending.running, false);
  }
  pass("hidden startup/custom/editor/tool dialogs cancel safely during explicit stop with all features disabled");
  const closing = await coreHost.create(beta, true);
  await coreHost.activate(closing.id);
  const closingRun = closing.runtime.session.prompt("cancel-before-start custom");
  await until(() => closing.prompts > 0, "shutdown dialog opens");
  let closed = false;
  const close = coreHost.close().then(() => { closed = true; });
  await until(() => closed, "host shutdown cancels pending custom dialog");
  await Promise.all([close, closingRun]);
  assert.equal(closing.activity, closing.lastError ? "failed" : "stopped");
  assert.equal(closing.running, false);
  pass("host shutdown cancels a pending custom dialog and preserves the interruption or structured abort error");
  const creatingHost = new NativeSessionHost(agentDir, () => new FakeTerminal(), disabled, []);
  const creating = creatingHost.create(beta, true, undefined, { id: "create-close" });
  const duplicate = creatingHost.create(beta, true, undefined, { id: "create-close" });
  const stoppingCreation = creatingHost.close();
  assert.equal(creatingHost.close(), stoppingCreation, "concurrent close callers share settlement");
  await assert.rejects(duplicate, /already in progress/);
  await assert.rejects(creating, /closed during session creation/);
  await stoppingCreation;
  assert.equal(creatingHost.sessions.get("create-close").runtime, undefined);
  pass("shutdown awaits pending creation and rejects duplicate native identities");
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  await coreHost?.close();
  await host.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
  clearTimeout(deadline);
}
// Native Pi keeps file/theme watchers and its input loop alive by design.
process.exit(process.exitCode || 0);
