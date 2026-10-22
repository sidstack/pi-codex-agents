import { createServer, type Server, type Socket } from "node:net";
import { chmod, realpath, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { getAgentDir, ProjectTrustStore, type ExtensionContext, type InteractiveMode } from "@earendil-works/pi-coding-agent";
import { createJsonlReader, encodeJsonl, MAX_JSONL_RECORD_BYTES } from "./jsonl.js";
import { NativeSessionHost, type Session } from "./sessions.js";
import { TerminalHub, RemoteTerminal } from "./remote-terminal.js";
import { acquireNativeLock, processIdentity, writeNativeRegistry } from "./storage.js";
import type { SessionFeature } from "../features/contracts.js";
import { loadConfig, nativeHostDirectory, type Config } from "../config.js";
import { assertManagedFile, privateDirectory, readPrivateJSON } from "./security.js";
import { VERSION, BUILD_ID, PROTOCOL_VERSION } from "../version.js";
import { countUnsettled } from "./activity.js";
import { NativeDraftStore } from "./drafts.js";
import { unsupportedContract } from "../pi-version.js";

export interface NativeSavedRecord {
  id: string; name: string; cwd: string; activity: Session["activity"];
  sessionFile?: string; sourceFile?: string; lastError?: string;
  draft?: string;
}
interface NativeRegistry { version: 1; activeId: string; sessions: NativeSavedRecord[]; }

export function nativeDaemonPaths(agentDir = getAgentDir()): { directory: string; socket: string; registry: string } {
  const directory = nativeHostDirectory(agentDir);
  return { directory, socket: join(directory, "host.sock"), registry: join(directory, "registry.json") };
}

/** Claim the kernel-level ownership of one state directory. Both the current and the
 * pre-rename abstract name are held, so an older build sharing the directory cannot start
 * a second host over the same registry; a host in another directory stays independent. */
async function claimHostOwnership(names: string[]): Promise<() => void> {
  const servers: Server[] = [];
  try {
    for (const name of names) {
      const server = createServer();
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(name, () => { server.off("error", reject); done(); });
      });
      servers.push(server);
    }
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }
  return () => { for (const server of servers) server.close(); };
}

export async function startNativeDaemon(cwd: string, config: Readonly<Config> = Object.freeze(loadConfig()), features: readonly SessionFeature[] = []): Promise<void> {
  const paths = nativeDaemonPaths();
  privateDirectory(paths.directory);
  // Linux abstract sockets are released by the kernel even after SIGKILL. This
  // serializes stale-file recovery as well as normal concurrent launcher starts.
  const suffix = `${process.getuid?.() ?? 0}-${createHash("sha256").update(await realpath(paths.directory)).digest("hex").slice(0, 24)}`;
  const releaseOwnership = await claimHostOwnership([`\0pi-codex-agents-native-${suffix}`, `\0pi-agents-native-${suffix}`]);
  // The kernel lock proves that no conforming host can still be writing. A
  // SIGKILL may have interrupted even the initial bytes of either lock record.
  for (const stale of [join(paths.directory, "host.lock"), `${paths.registry}.lock`]) {
    try { await unlink(stale); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const unlock = acquireNativeLock(join(paths.directory, "host.lock"));
  const agentDir = getAgentDir();
  const hub = new TerminalHub();
  const host = new NativeSessionHost(agentDir, () => new RemoteTerminal(hub), config, features);
  const drafts = new NativeDraftStore(paths.directory);
  host.foregroundVisible = false;
  const sessionRoot = join(agentDir, "sessions");
  privateDirectory(sessionRoot);
  let attached: Socket | undefined;
  let ending = false;
  let exitMenu = false;
  let initializing = true;
  // The Home session this host created while starting up. It belongs to the frontend
  // launch that started this host, so only that launch's attachment may claim it.
  let launchHomeId: string | undefined;
  const server = createServer(handleConnection);
  let saved: NativeRegistry | undefined;
  if (existsSync(paths.registry)) {
    saved = readPrivateJSON(paths.registry) as NativeRegistry;
    if (saved?.version !== 1 || typeof saved.activeId !== "string" || !Array.isArray(saved.sessions)) throw new Error("Invalid native host registry; refusing to discard saved sessions");
    const ids = new Set<string>();
    for (const row of saved.sessions) {
      if (!row || typeof row.id !== "string" || ids.has(row.id) || typeof row.cwd !== "string" || !row.cwd.startsWith("/") || typeof row.name !== "string" || !["ready", "running", "waiting", "failed", "inactive", "stopped"].includes(row.activity) || (row.sessionFile !== undefined && typeof row.sessionFile !== "string") || (row.sourceFile !== undefined && typeof row.sourceFile !== "string") || (row.draft !== undefined && typeof row.draft !== "string") || (row.lastError !== undefined && typeof row.lastError !== "string")) throw new Error("Invalid session in native host registry");
      ids.add(row.id);
    }
  }
  const write = (socket: Socket, message: unknown) => {
    if (socket.destroyed) return;
    if (socket.writableLength > 2 * 1024 * 1024) { socket.destroy(); return; }
    const record = encodeJsonl(message);
    if (Buffer.byteLength(record) - 1 > MAX_JSONL_RECORD_BYTES) { socket.destroy(); return; }
    socket.write(record);
  };
  hub.send = (message) => { if (attached) write(attached, message); };
  const snapshot = () => ({
    version: VERSION, buildId: BUILD_ID, protocolVersion: PROTOCOL_VERSION, pid: process.pid, identity: processIdentity(), initializing, attached: Boolean(attached), activeId: host.activeId,
    // A host that predates settledStop cannot be trusted to shut itself down without
    // recording settled sessions as stopped, so the frontend will not replace it silently.
    capabilities: ["settledStop", "safeUpdate"],
    unsettledCount: countUnsettled([...host.sessions.values()]),
    sessions: [...host.sessions.values()].map((r) => ({ id: r.id, name: r.name, cwd: r.cwd, activity: r.activity,
      running: r.running, prompts: r.prompts, pendingOperations: r.pendingOperations, unread: r.unread, lastError: r.lastError, sessionFile: r.sessionFile,
      sourceFile: r.sourceFile })),
  });
  const persist = () => {
    const current = snapshot();
    for (const row of host.sessions.values()) drafts.save(row.id, row.context?.ui.getEditorText() ?? row.draft);
    writeNativeRegistry(paths.registry, { version: 1, activeId: current.activeId,
      sessions: current.sessions.filter((row) => row.sessionFile || !row.sourceFile) }, 2 * 1024 * 1024);
    if (attached) write(attached, { type: "state", ...current });
  };
  const statusChange = host.onChange;
  host.onChange = () => { statusChange(); if (!ending && !initializing) persist(); };
  const detach = (socket = attached) => {
    if (!socket || socket !== attached) return;
    attached = undefined;
    host.foregroundVisible = false;
    const row = host.sessions.get(host.activeId);
    row?.view?.ui.stop();
    if (row?.view) row.view.lease.enabled = false;
    persist();
  };
  const connections = new Set<Socket>();
  const stopAll = async (options: { quitFrontend?: boolean; restart?: boolean } = {}) => {
    if (ending) return;
    ending = true;
    let failed = false;
    try { await host.close(); } catch (error) { console.error(error); failed = true; }
    try { persist(); } catch (error) { console.error(error); failed = true; }
    for (const socket of connections) {
      write(socket, { type: "stopped", quitFrontend: options.quitFrontend === true, restart: options.restart === true });
      socket.end();
    }
    server.close();
    try { await unlink(paths.socket); } catch {}
    unlock();
    releaseOwnership();
    // A stopped host must actually stop: an unref'd timer would let a lingering handle
    // keep the process alive after its socket and lock are released.
    setTimeout(() => process.exit(failed ? 1 : 0), 100);
  };
  // "quit" comes from Pi's own exit keys inside a managed view (/quit, Ctrl+D, double
  // Ctrl+C) and from the command center's Ctrl+Q. Those keys belong to a host-owned mode,
  // so they cannot end the frontend Pi process by themselves; the host reports the choice
  // and the frontend shuts Pi down. "leave" is Ctrl+Z: the way back to the Pi editor the
  // frontend launched, which never touches the frontend.
  const requestExit = async (trigger: "quit" | "leave") => {
    if (exitMenu || ending || !attached) return;
    const row = host.sessions.get(host.activeId);
    if (!row?.context) return;
    exitMenu = true;
    try {
      const quitting = trigger === "quit";
      const keep = quitting ? "Keep sessions running and quit Pi" : "Keep sessions running in background";
      const stop = quitting ? "Stop all managed sessions and quit Pi" : "Stop all managed sessions";
      const result = await row.context.ui.select(quitting ? "Quit the managed session?" : "Leave command center?", [keep, stop, "Cancel"]);
      if (result === keep && attached) {
        const socket = attached;
        detach(socket);
        write(socket, { type: "detached", quitFrontend: quitting,
          reason: quitting ? "Sessions remain running in the background. Exiting Pi." : "Sessions remain running. Open /agents to reconnect." });
        socket.end();
      } else if (result === stop) await stopAll({ quitFrontend: quitting });
    } finally { exitMenu = false; }
  };
  host.onExit = () => requestExit("quit");
  host.onLeave = () => requestExit("leave");
  host.onStop = async () => {
    const ctx = host.sessions.get(host.activeId)?.context;
    if (ctx && await ctx.ui.confirm("Stop managed agents?", "Abort all managed runs and stop their host? Native history is retained.")) await stopAll();
  };
  // /agents restart typed inside a managed view: this host replaces itself and the frontend
  // starts the installed build and reconnects.
  host.onRestart = async () => {
    const row = host.sessions.get(host.activeId);
    if (!row?.context || ending) return;
    const busy = countUnsettled([...host.sessions.values()]);
    if (busy && !await row.context.ui.confirm("Restart the agent host?", `${busy} session(s) are running or waiting. Restarting aborts their runs and disposes pending dialogs.`)) return;
    await stopAll({ restart: true });
  };
  host.prepareMode = (mode: InteractiveMode) => {
    // Instance adapter only. A daemon has no process terminal to suspend or exit.
    // Pi's default shutdown calls process.exit; this host owns that decision.
    const native = mode as unknown as {
      registerSignalHandlers: () => void; shutdown: () => Promise<void>;
      handleCtrlZ: () => void; shutdownRequested: boolean;
    };
    for (const key of ["registerSignalHandlers", "shutdown", "handleCtrlZ"] as const) {
      if (typeof native[key] !== "function") throw new Error(unsupportedContract(`owned mode method ${key}`));
    }
    native.registerSignalHandlers = () => {};
    native.shutdown = async () => { native.shutdownRequested = false; await requestExit("quit"); };
    native.handleCtrlZ = () => { void requestExit("leave"); };
  };
  const trusted = (directory: string) => new ProjectTrustStore(agentDir).get(directory) === true;
  const recoveries = new Map<string, Promise<void>>();
  const suspendIfDetached = (record: Session) => {
    if (attached || !record.view) return;
    record.view.ui.stop();
    record.view.lease.enabled = false;
  };
  const suspendIfDetachedCurrent = () => {
    const current = host.sessions.get(host.activeId);
    if (current) suspendIfDetached(current);
  };
  const recover = async (record: Session, ctx: ExtensionContext): Promise<void> => {
    await host.waitForInactivity(record.id);
    if (record.sessionFile) {
      assertManagedFile(sessionRoot, record.sessionFile);
      const resumed = await host.create(record.cwd, trusted(record.cwd), undefined, {
        id: record.id, name: record.name, sessionFile: record.sessionFile, sourceFile: record.sourceFile, draft: record.draft,
      });
      await host.activate(resumed.id);
      suspendIfDetached(resumed);
      return;
    }
    if (!record.sourceFile) {
      const resumed = await host.create(record.cwd, trusted(record.cwd), undefined, { id: record.id, name: record.name, draft: record.draft });
      await host.activate(resumed.id);
      suspendIfDetached(resumed);
      return;
    }
    const source = await host.findHistory(record.sourceFile);
    if (!source) throw new Error("Saved history is no longer available");
    const recovered = await host.create(source.cwd, trusted(source.cwd), undefined, {
      id: record.id, name: source.name.replace(/^Saved /, "Recovered "), sourceFile: source.sourceFile,
    });
    await host.activate(recovered.id);
    suspendIfDetached(recovered);
    ctx.ui.notify("Recovered saved history into a new native session. The original history was not modified.", "info");
  };
  host.onRecover = (record, ctx) => {
    const pending = recoveries.get(record.id);
    if (pending) return pending;
    const task = recover(record, ctx).finally(() => { recoveries.delete(record.id); });
    recoveries.set(record.id, task);
    return task;
  };
  try {
    // The lifetime lock excludes another daemon before any saved file is opened.
    for (const item of saved?.sessions ?? []) {
      if (item.sourceFile && !item.sessionFile) continue;
      item.draft = drafts.load(item.id, item.draft);
      if (item.sessionFile) {
        try { assertManagedFile(sessionRoot, item.sessionFile); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          host.sessions.set(item.id, { ...item, activity: "failed", lastError: `Managed history is unavailable: ${item.sessionFile}`, running: false, prompts: 0, unread: true });
          continue;
        }
      }
      if (item.activity === "stopped" || item.activity === "inactive" || !item.sessionFile) {
        if (item.id === "home" && item.sessionFile) {
          assertManagedFile(sessionRoot, item.sessionFile);
          try { await host.create(item.cwd, trusted(item.cwd), undefined, item); }
          catch (error) { host.fail(host.sessions.get(item.id)!, error); }
          continue;
        }
        host.sessions.set(item.id, { ...item, running: false, prompts: 0, unread: false });
        continue;
      }
      assertManagedFile(sessionRoot, item.sessionFile);
      let row: Session;
      try { row = await host.create(item.cwd, trusted(item.cwd), undefined, item); }
      catch (error) { host.fail(host.sessions.get(item.id)!, error); continue; }
      if (item.activity === "running" || item.activity === "waiting" || !existsSync(item.sessionFile)) {
        host.fail(row, "Previous host ended during this session. History restored; review the transcript before continuing.");
      } else if (item.lastError) host.fail(row, item.lastError);
    }
    const previousHome = host.sessions.get("home");
    if (previousHome && !previousHome.view) {
      const id = `unavailable-home:${createHash("sha256").update(previousHome.sessionFile ?? previousHome.cwd).digest("hex").slice(0, 20)}`;
      host.sessions.delete("home");
      host.sessions.set(id, { ...previousHome, id, name: "Previous Home", activity: "failed" });
    }
    if (!host.sessions.has("home")) {
      const directory = existsSync(cwd) ? cwd : homedir();
      await host.create(directory, trusted(directory), undefined, { id: "home", name: "Home" });
      launchHomeId = "home";
    }
    await host.refreshFeatures();
    host.activeId = saved?.activeId && host.sessions.get(saved.activeId)?.view ? saved.activeId : "home";
    // Initialize a native editor without a physical terminal. Runs remain owned here.
    const initial = host.sessions.get(host.activeId)!;
    host.startFeatures();
    // Listen before awaiting session_start: an extension may need user input to
    // finish startup. Attach can render that same initializing native view.
    try { await unlink(paths.socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, () => { server.off("error", reject); done(); });
    });
    await chmod(paths.socket, 0o600);
    await initial.view!.start();
    suspendIfDetached(initial);
    initializing = false;
    persist();
  } catch (error) {
    ending = true;
    for (const socket of connections) socket.destroy();
    server.close();
    try { await host.close(); } catch (cleanupError) { console.error(cleanupError); }
    try { await unlink(paths.socket); } catch {}
    unlock();
    releaseOwnership();
    throw error;
  }

  async function attach(socket: Socket, message: Record<string, unknown>): Promise<void> {
    if (attached && attached !== socket) {
      if (message.takeover !== true) throw new Error("Native host is already attached. Use /agents takeover to move its terminal here without stopping sessions.");
      const previous = attached;
      detach(previous);
      write(previous, { type: "detached", reason: "Terminal moved to another frontend; sessions kept running." });
      previous.end();
    }
    attached = socket;
    host.foregroundVisible = true;
    // Any attachment consumes the startup Home: a second frontend, a manual /agents or a
    // reconnect after an internal restart all get their own view instead of that session.
    const claimHomeId = launchHomeId;
    launchHomeId = undefined;
    hub.dimensions(Number(message.columns) || 100, Number(message.rows) || 30, Boolean(message.kitty));
    // A frontend launches Pi in a directory, so the host gives that launch a session for the
    // directory: a new one by default, or the directory's last session when resumeLastSession is on.
    // A failure here never breaks the attachment: the previous foreground session stays usable.
    const launchCwd = typeof message.launchCwd === "string" && message.launchCwd.startsWith("/") ? message.launchCwd : undefined;
    let launchError: string | undefined;
    // Preparing the target does not start its interactive view.
    let targetId = host.activeId;
    if (launchCwd) {
      try {
        const target = await host.launchSessionForCwd(launchCwd, trusted, claimHomeId);
        targetId = target.id;
        launchError = target.launchError;
      } catch (error) {
        launchError = `Could not start a session for ${launchCwd}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(launchError);
      }
      // The frontend may have gone away while the target was prepared. Never hand a
      // terminal lease to a socket that no longer owns the attachment.
      if (attached !== socket || ending) { suspendIfDetachedCurrent(); return; }
    }
    write(socket, { type: "response", id: message.id, success: true, result: { ...snapshot(), launchError } });
    // Activation is after the ACK. Native startup can wait for a human answer, and the
    // frontend attach timeout must not cut that answer off while the terminal is lent here.
    if (targetId !== host.activeId) {
      try {
        await host.activate(targetId);
      } catch (error) {
        // NativeFleet.activate restores the previous foreground view before rethrowing.
        launchError = `Could not show the session for ${launchCwd}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(launchError);
      }
      if (attached !== socket || ending) { suspendIfDetachedCurrent(); return; }
    }
    const row = host.sessions.get(host.activeId);
    if (!row?.view) {
      console.error(`Native view is unavailable for ${host.activeId}`);
      return;
    }
    row.unread = false;
    row.view.lease.enabled = true;
    await row.view.start();
    if (attached !== socket || ending) { suspendIfDetached(row); return; }
    row.view.lease.restore();
    if (launchError) row.context?.ui.notify(launchError, "error");
    row.view.ui.requestRender(true);
    persist();
  }

  function handleConnection(socket: Socket): void {
    if (ending || connections.size >= 32) { socket.destroy(); return; }
    connections.add(socket);
    let pendingRequests = 0;
    let queue = Promise.resolve();
    const reader = createJsonlReader((raw) => {
      if (!raw || typeof raw !== "object" || "__parseError" in raw) { socket.destroy(); return; }
      const message = raw as Record<string, unknown>;
      if (message.type === "input" && socket === attached && typeof message.data === "string") {
        hub.kittyProtocolActive = Boolean(message.kitty);
        hub.active?.input?.(message.data);
        return;
      }
      if (message.type === "resize" && socket === attached) {
        hub.dimensions(Number(message.columns) || 100, Number(message.rows) || 30, Boolean(message.kitty));
        return;
      }
      if (++pendingRequests > 64) { socket.destroy(); return; }
      queue = queue.then(async () => {
        try {
          if (socket.destroyed || ending) return;
          if (message.type === "attach") { await attach(socket, message); return; }
          let result: unknown;
          if (message.type === "status") { await host.refreshFeatures(); result = snapshot(); }
          else if (message.type === "open") {
            if (socket !== attached) throw new Error("Attach before opening the command center");
            const context = host.sessions.get(host.activeId)?.context;
            if (!context) throw new Error("Active session is unavailable");
            void host.open(context).catch((error) => context.ui.notify(error instanceof Error ? error.message : String(error), "error"));
            result = { opened: true };
          }
          else if (message.type === "detach") { detach(socket); result = { detached: true }; }
          else if (message.type === "stop") {
            // An automatic build update may only stop a host that owns nothing unsettled.
            const busy = countUnsettled([...host.sessions.values()]);
            if (message.onlyIfSettled === true && (busy || attached || initializing)) {
              write(socket, { type: "response", id: message.id, success: false, error: busy ? `${busy} session(s) are running or waiting` : attached ? "A frontend terminal is attached" : "Native session startup is still in progress" });
              return;
            }
            write(socket, { type: "response", id: message.id, success: true, result: { stopping: true } });
            await stopAll(); return;
          } else if (message.type === "recover" && typeof message.sessionId === "string") {
            const record = host.sessions.get(message.sessionId);
            const context = host.sessions.get(host.activeId)?.context;
            if (!record || record.view || !context) throw new Error("Saved session is unavailable");
            // Recovery is a command, never an automatic model continuation.
            await host.onRecover?.(record, context); result = snapshot();
          } else throw new Error("Unknown native host request");
          write(socket, { type: "response", id: message.id, success: true, result });
        } catch (error) {
          write(socket, { type: "response", id: message.id, success: false, error: error instanceof Error ? error.message : String(error) });
        } finally { pendingRequests--; }
      }).catch((error) => { console.error(error); socket.destroy(); });
    }, 1024 * 1024);
    socket.on("data", (chunk) => { reader.write(chunk); if (reader.pending() > 1024 * 1024) socket.destroy(); });
    socket.on("error", () => {});
    socket.on("close", () => { connections.delete(socket); detach(socket); });
  }

  function fatal(error: unknown): void { console.error(error); void stopAll(); }
  process.on("SIGTERM", () => { void stopAll(); });
  process.on("SIGINT", () => { void stopAll(); });
  process.on("SIGHUP", () => {}); // The host has an independent lifetime from terminals.
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);

}

