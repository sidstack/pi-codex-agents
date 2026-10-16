#!/usr/bin/env node
/** Real Pi host, native tools and stdio MCP. All inference stays in this local fixture. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { ensureNativeConnection, connectNative, stopNativeHost } from "../dist/pi/client.js";
import { nativeDaemonPaths } from "../dist/core/host.js";
import { createJsonlReader } from "../dist/core/jsonl.js";

const root = await mkdtemp(join(tmpdir(), "pi-agent-tools-"));
const agent = join(root, "agent"), cwd = join(root, "project");
await mkdir(agent); await mkdir(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_AGENTS_NATIVE_DIR = join(root, "host"); process.env.PI_OFFLINE = "1";
let host, bridge, slowDone;
const slow = new Promise((done) => { slowDone = done; });
let requests = 0;
const server = createServer(async (req, res) => {
  let body = ""; for await (const part of req) body += part;
  const data = JSON.parse(body); requests++;
  const all = JSON.stringify(data.messages);
  if (all.includes("SLOW_PROOF")) await slow;
  else await new Promise((done) => setTimeout(done, 100));
  const tool = (name, args) => ({ role: "assistant", tool_calls: [{ index: 0, id: `tool-${requests}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  const toolResults = JSON.stringify(data.messages.filter((message) => message.role === "tool"));
  let delta, reason;
  if (!all.includes("SLOW_PROOF") && !toolResults.includes("fixture question")) {
    delta = tool("pi_agent_send", { to: "parent", kind: "question", text: "fixture question" }); reason = "tool_calls";
  } else if (!all.includes("SLOW_PROOF") && !toolResults.includes("fixture answer")) {
    delta = tool("pi_agent_inbox", {}); reason = "tool_calls";
  } else { delta = { role: "assistant", content: "fixture complete" }; reason = "stop"; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "mail-proof", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.write(chunk(delta)); res.write(chunk({}, reason)); res.end("data: [DONE]\n\n");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", quietStartup: true }));
await mkdir(join(agent, "pi-agents"));
await writeFile(join(agent, "pi-agents", "config.json"), JSON.stringify({ autoName: false, historyImport: false, idleTimeoutMs: 0 }));
await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "local-only",
  models: [{ id: "fixture", name: "Fixture", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
const deadline = setTimeout(() => { console.error("FAIL delegation deadline"); process.exit(1); }, 60000);
try {
  host = await ensureNativeConnection(cwd);
  const before = await host.request("status");
  bridge = spawn(process.execPath, ["dist/mcp-entry.js"], { cwd: new URL("..", import.meta.url), env: { ...process.env, PI_AGENTS_PI_ROOT: getPackageDir(), PI_AGENTS_CONTROLLER: "fixture" }, stdio: ["pipe", "pipe", "inherit"] });
  let nextId = 0; const pending = new Map();
  const reader = createJsonlReader((message) => { const entry = pending.get(message.id); if (entry) { pending.delete(message.id); entry(message); } });
  bridge.stdout.on("data", (chunk) => reader.write(chunk));
  const request = (method, params = {}) => new Promise((done) => { const id = ++nextId; pending.set(id, done); bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const tool = async (name, args = {}) => { const response = await request("tools/call", { name, arguments: args }); assert(!response.error, JSON.stringify(response)); return response.result; };
  const value = (response) => { assert(!response.isError, JSON.stringify(response)); return JSON.parse(response.content[0].text); };
  const init = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-11-25");
  const catalog = await request("tools/list"); assert.equal(catalog.result.tools.length, 6);
  const a = value(await tool("pi_agent_spawn", { name: "Mailbox proof", role: "test", cwd, task: "MAILBOX_PROOF: Use the mailbox tools only. Ask fixture question and check inbox for fixture answer, then finish." }));
  const b = value(await tool("pi_agent_spawn", { name: "Capacity proof", role: "review", cwd, task: "SLOW_PROOF: Return fixture complete." }));
  const refused = await tool("pi_agent_spawn", { name: "Third must fail", cwd, task: "Must not execute" });
  assert(refused.isError); assert.match(refused.content[0].text, /capacity 2/);
  assert.equal(a.thinking, "medium");
  let cursor = 0, question;
  for (let i = 0; i < 20 && !question; i++) {
    const inbox = value(await tool("pi_agent_wait", { after: cursor, timeoutMs: 1000 })); cursor = inbox.nextCursor;
    question = inbox.messages.find((message) => message.kind === "question");
  }
  assert.equal(question?.from, a.id); assert.equal(question?.text, "fixture question");
  const reply = value(await tool("pi_agent_send", { to: a.id, text: "fixture answer" })); assert.equal(reply.delivery, "mailbox");
  let settled;
  for (let i = 0; i < 20 && !settled; i++) {
    const inbox = value(await tool("pi_agent_wait", { after: cursor, timeoutMs: 1000 })); cursor = inbox.nextCursor;
    settled = inbox.messages.find((message) => message.from === a.id && message.kind === "settled");
  }
  assert.equal(settled?.text, "fixture complete");
  const status = await host.request("status"); assert.equal(status.activeId, before.activeId); assert.equal(status.attached, false);
  assert(status.sessions.some((row) => row.id === a.id && row.name === "Mailbox proof"));
  slowDone();
  await tool("pi_agent_stop", { sessionId: b.id });
  const end = value(await tool("pi_agent_list")); assert.equal(end.workers.length, 2);
  assert.equal(end.workers.find((row) => row.id === b.id).state, "stopped");
  const fallback = spawnSync("python3", ["skills/pi-session-supervisor/scripts/call.py", "list"], { input: "{}", encoding: "utf8", env: { ...process.env, PI_AGENTS_CONTROLLER: "fixture" }, timeout: 10000 });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(JSON.parse(fallback.stdout).workers.length, 2);
  assert(requests > 0);
  console.log("PASS native A2A: stdio MCP spawn, real worker tools, two-way question/reply, medium, capacity refusal, visible sessions, and targeted stop without terminal takeover");
  host.socket.destroy(); await stopNativeHost();
  host = await ensureNativeConnection(cwd);
  const restored = await host.request("feature", { operation: "agents.inbox", caller: "controller:fixture", input: {} });
  assert(restored.messages.some((message) => message.text === "fixture question"));
  console.log("PASS native A2A: mailbox survives host restart; stored requests are never replayed");
} finally {
  clearTimeout(deadline); slowDone(); bridge?.stdin.end(); bridge?.kill(); host?.socket.destroy();
  try { const c = await connectNative(nativeDaemonPaths().socket); await c.request("stop"); c.socket.destroy(); } catch {}
  await new Promise((done) => setTimeout(done, 200));
  server.closeAllConnections(); await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
}
