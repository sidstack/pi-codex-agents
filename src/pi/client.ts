import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateAppend } from "../core/security.js";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { createJsonlReader, encodeJsonl } from "../core/jsonl.js";
import { checkNativeVersion } from "../core/sessions.js";
import { nativeDaemonPaths } from "../core/host.js";
import { VERSION, BUILD_ID, PROTOCOL_VERSION } from "../version.js";
import { countUnsettled, type ActivitySnapshot } from "../core/activity.js";

/** The host answered this request and refused it. Distinct from a lost or timed out
 * request: the connection is still valid and the host is still serving requests. */
export class HostResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostResponseError";
  }
}

export class NativeConnection {
  private nextId = 0;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  onEvent: (message: Record<string, unknown>) => void = () => {};
  /** Set when the running host predates this build; the frontend reports it once. */
  hostNotice = "";
  constructor(readonly socket: Socket) {
    const reader = createJsonlReader((raw) => {
      if (!raw || typeof raw !== "object" || "__parseError" in raw) { socket.destroy(new Error("Malformed native host response")); return; }
      const message = raw as Record<string, unknown>;
      if (message.type === "response" && typeof message.id === "string") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.success === true) pending.resolve(message.result);
        else pending.reject(new HostResponseError(String(message.error)));
      } else {
        try { this.onEvent(message); }
        catch (error) { socket.destroy(error instanceof Error ? error : new Error(String(error))); }
      }
    });
    socket.on("data", (chunk) => { reader.write(chunk); if (reader.pending() > 4 * 1024 * 1024) socket.destroy(new Error("Native host record too large")); });
    socket.on("error", () => {});
    socket.on("close", () => {
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Native host connection closed")); }
      this.pending.clear();
    });
  }
  send(message: unknown): void {
    if (this.socket.destroyed) return;
    if (this.socket.writableLength > 2 * 1024 * 1024) { this.socket.destroy(new Error("Native host input queue exceeded its limit")); return; }
    const record = encodeJsonl(message);
    if (Buffer.byteLength(record) > 1024 * 1024) { this.socket.destroy(new Error("Native host request exceeded its byte limit")); return; }
    this.socket.write(record);
  }
  request(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (this.socket.destroyed) return Promise.reject(new Error("Native host connection closed"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Too many pending native host requests"));
    const id = String(++this.nextId);
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Native host request timed out: ${type}`)); }, 30000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.send({ ...fields, type, id });
    });
  }
}

export async function connectNative(path: string): Promise<NativeConnection> {
  return new Promise((done, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Native host connect timed out")); }, 1500);
    socket.once("connect", () => { clearTimeout(timer); socket.off("error", failed); done(new NativeConnection(socket)); });
    function failed(error: Error): void { clearTimeout(timer); reject(error); }
    socket.once("error", failed);
  });
}

export interface ConnectOptions {
  /** Replace a settled, unattached host that predates this build. Default true. */
  autoUpdateHost?: boolean;
}

const unreachable = (error: unknown): boolean => ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");

async function waitForHostRelease(socketPath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    await new Promise((done) => setTimeout(done, 50));
    try { const probe = await connectNative(socketPath); probe.socket.destroy(); }
    catch (error) { if (unreachable(error)) return; }
  }
  throw new Error("The agent host did not stop within 10 seconds.");
}

export async function ensureNativeConnection(cwd: string, start = true, agentDir = getAgentDir(), options: ConnectOptions = {}): Promise<NativeConnection> {
  if (start) checkNativeVersion();
  const paths = nativeDaemonPaths(agentDir);
  let replaced = false;
  try {
    const connection = await connectNative(paths.socket);
    if (start) {
      let stale: { version: string; busy: number; attached: boolean; settledStop: boolean; safeUpdate: boolean } | undefined;
      try {
        const status = await connection.request("status") as { version?: string; buildId?: string; protocolVersion?: number; attached?: boolean; capabilities?: string[]; sessions?: ActivitySnapshot[] };
        if (status.protocolVersion !== PROTOCOL_VERSION) {
          const busy = countUnsettled(status.sessions ?? []);
          throw new Error(`The running agent host speaks protocol ${status.protocolVersion ?? "unknown"}; this build needs ${PROTOCOL_VERSION}. ${busy ? `${busy} session(s) are running or waiting: finish them, then ` : ""}run /agents restart to start the updated host.`);
        }
        if (status.version !== VERSION || status.buildId !== BUILD_ID) {
          stale = { version: status.version ?? "an unknown version", attached: status.attached === true,
            settledStop: status.capabilities?.includes("settledStop") === true,
            safeUpdate: status.capabilities?.includes("safeUpdate") === true,
            busy: countUnsettled(status.sessions ?? []) };
        }
      } catch (error) { connection.socket.destroy(); throw error; }
      if (!stale) return connection;
      // Nothing is at stake only when the host owns no unsettled run, no other frontend is
      // looking at it, and the host itself can shut down without flattening settled sessions.
      if (options.autoUpdateHost === false || stale.busy > 0 || stale.attached || !stale.settledStop || !stale.safeUpdate) {
        connection.hostNotice = `The agent host still runs ${stale.version} from before this update. ${stale.busy ? `${stale.busy} session(s) are running or waiting; ` : ""}new code applies after /agents restart, and nothing was interrupted.`;
        return connection;
      }
      try {
        await connection.request("stop", { onlyIfSettled: true });
      } catch (error) {
        if (error instanceof HostResponseError) {
          // The host answered and refused: it kept its sessions, so this connection is
          // still the live host connection. Destroying it would strand the frontend.
          connection.hostNotice = `The agent host still runs ${stale.version} from before this update (${error.message}). Run /agents restart when its work is done.`;
          return connection;
        }
        // No answer arrived, so the request died with the transport or timed out. Nothing
        // further can be trusted on this socket: clean it up and report the failure.
        connection.socket.destroy();
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`The automatic update could not complete (${reason}). Inspect /agents status before restarting the host.`, { cause: error });
      }
      connection.socket.destroy();
      await waitForHostRelease(paths.socket);
      replaced = true;
    } else return connection;
  } catch (error) {
    if (!unreachable(error)) throw error;
    if (!start) throw new Error("Native host is not running");
  }
  const logPath = join(paths.directory, "host.log");
  const log = privateAppend(logPath);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../host-entry.js", import.meta.url)), cwd], {
    cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AGENTS_PI_ROOT: getPackageDir(), PI_AGENTS_NATIVE_DAEMON: "1" }, detached: true, stdio: ["ignore", log, log],
  });
  child.on("error", () => {});
  child.unref(); closeSync(log);
  for (let attempt = 0; attempt < 300; attempt++) {
    await new Promise((done) => setTimeout(done, 100));
    try {
      const connection = await connectNative(paths.socket);
      if (replaced) connection.hostNotice = "Agent host updated to the current build; nothing was running.";
      return connection;
    } catch {}
  }
  throw new Error(`Native host did not start. Inspect the private log at ${logPath}`);
}

/** Stop the running host and wait until it releases its socket, so the next connection
 * starts the current build. Explicit user action: it aborts the runs that host owns. */
export async function stopNativeHost(agentDir = getAgentDir(), options: { onlyIfSettled?: boolean } = {}): Promise<void> {
  const paths = nativeDaemonPaths(agentDir);
  const closed = () => connectNative(paths.socket).then((probe) => { probe.socket.destroy(); return false; },
    (error) => ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? ""));
  try {
    const connection = await connectNative(paths.socket);
    try { await connection.request("stop", { onlyIfSettled: options.onlyIfSettled === true }); }
    catch (error) { if (error instanceof HostResponseError) throw error; }
    finally { connection.socket.destroy(); }
  } catch (error) {
    if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    await new Promise((done) => setTimeout(done, 50));
    if (await closed()) return;
  }
  throw new Error("The agent host did not stop within 10 seconds.");
}
