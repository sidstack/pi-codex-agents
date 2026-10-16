/** Local stdio control bridge only: Pi's persistent host owns all execution. */
import { VERSION } from "./version.js";
import { registerInstalledSdk } from "./pi/sdk-loader.js";
registerInstalledSdk(process.env.PI_AGENTS_PI_ROOT);
const [{ AGENT_TOOLS }, { connectNative }, { nativeDaemonPaths }, { createJsonlReader, encodeJsonl }] = await Promise.all([
  import("./agent-tools.js"), import("./pi/client.js"), import("./core/host.js"), import("./core/jsonl.js"),
]);
const caller = `controller:${process.env.PI_AGENTS_CONTROLLER ?? "codex"}`;
if (!/^controller:[a-zA-Z0-9._:-]{1,100}$/.test(caller)) throw new Error("Invalid controller identity");
let inflight = 0;
const sockets = new Set<Awaited<ReturnType<typeof connectNative>>>();
function output(message: unknown): void {
  if (process.stdout.writableLength > 2 * 1024 * 1024) { process.stdin.destroy(); process.exitCode = 1; return; }
  process.stdout.write(encodeJsonl(message));
}
async function call(name: unknown, input: unknown): Promise<unknown> {
  const tool = AGENT_TOOLS.find((candidate) => candidate.name === name);
  if (!tool || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("Unknown tool or invalid arguments");
  // The optional local admission probe also counts cancelled requests still
  // draining in an inference server outside the host's ownership.
  const healthUrl = process.env.PI_AGENTS_HEALTH_URL;
  const admission = async () => {
    if (!healthUrl) return;
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Backend health returned ${response.status}`);
    const state = await response.json() as { active?: number; queued?: number; maintenance?: boolean };
    if (!Number.isFinite(state.active) || !Number.isFinite(state.queued) || state.maintenance || state.active! >= 2 || state.queued! > 0) throw new Error("Local inference capacity is occupied or draining; wait before starting more work");
  };
  if (tool.operation === "spawn") await admission();
  const connection = await connectNative(nativeDaemonPaths().socket).catch((error: unknown) => {
    throw new Error(`Native Pi host is unreachable; open /agents in Pi first (${error instanceof Error ? error.message : String(error)})`);
  });
  sockets.add(connection);
  try {
    if (healthUrl && tool.operation === "send" && (input as Record<string, unknown>).wake === true) {
      const group = await connection.request("feature", { operation: "agents.list", input: {}, caller }) as { workers: { id: string; running: boolean }[] };
      if (!group.workers.find((worker) => worker.id === (input as Record<string, unknown>).to)?.running) await admission();
    }
    return await connection.request("feature", { operation: `agents.${tool.operation}`, input, caller });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}. Use /agents to start the installed host, or /agents restart when settled if it predates agent tools.`);
  } finally { sockets.delete(connection); connection.socket.end(); }
}
async function handle(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== "object" || "__parseError" in raw) { output({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid bounded JSON record" } }); return; }
  const request = raw as { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };
  if (request.id === undefined) return;
  if (request.jsonrpc !== "2.0" || !["string", "number"].includes(typeof request.id)) { output({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }); return; }
  const id = request.id;
  if (++inflight > 32) { inflight--; output({ jsonrpc: "2.0", id, error: { code: -32000, message: "Too many pending requests" } }); return; }
  try {
    let result: unknown;
    if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "pi-agents", version: VERSION }, instructions: "Native Pi workers: maximum two local executions, medium thinking, compact mailbox supervision. Start the host in Pi; this bridge never starts or restarts it." };
    else if (request.method === "ping") result = {};
    else if (request.method === "tools/list") result = { tools: AGENT_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    else if (request.method === "tools/call") {
      try { const data = await call(request.params?.name, request.params?.arguments ?? {}); result = { content: [{ type: "text", text: JSON.stringify(data) }] }; }
      catch (error) { result = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
    } else { output({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }); return; }
    output({ jsonrpc: "2.0", id, result });
  } catch (error) { output({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); }
  finally { inflight--; }
}
const reader = createJsonlReader((raw) => { void handle(raw).catch((error: unknown) => console.error(error)); }, 1024 * 1024);
process.stdin.on("data", (chunk: Buffer) => reader.write(chunk));
process.stdin.on("end", () => { for (const connection of sockets) connection.socket.destroy(); });
process.stdout.on("error", () => { for (const connection of sockets) connection.socket.destroy(); process.stdin.destroy(); });
