import { realpath, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  getPackageDir, hasTrustRequiringProjectResources, InteractiveMode, ProjectTrustStore, SessionManager, SettingsManager,
  type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory, type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Terminal, type TUI } from "@earendil-works/pi-tui";
import { CommandCenter, commandCenterSize, type BoardAction } from "../ui/board.js";
import { PathPicker, expandDirectory, type PickerProject } from "../ui/path-picker.js";
import { isNavigable, NativeFleet, type LiveSession, type NativeView } from "./fleet.js";
import { loadConfig, type Config } from "../config.js";
import type { SessionFeature } from "../features/contracts.js";
import { privateDirectory, assertManagedFile } from "./security.js";
import { TerminalLease } from "./terminal.js";
import { nativePromptCancellation } from "./native-prompts.js";
import { PI_VERSION_RANGE, supportedPiVersion } from "../pi-version.js";
import { countUnsettled } from "./activity.js";

export interface Session extends LiveSession {
  context?: ExtensionContext;
  runtime?: AgentSessionRuntime;
  mode?: InteractiveMode;
  removeInput?: () => void;
  sessionFile?: string;
  sourceFile?: string;
  draft?: string;
}

/** What a frontend should show for its own launch directory, and what went wrong getting there. */
export interface LaunchSessionResult {
  id: string;
  /** The directory's saved history could not be resumed; a usable session was started instead. */
  launchError?: string;
}

export interface NativeSessionOptions {
  id?: string;
  name?: string;
  sessionFile?: string;
  sourceFile?: string;
  draft?: string;
}

// Pi exposes no public attach API. Keep the one private-field dependency here,
// guarded at runtime and restricted to the exact version tested by pi-agents.
export function nativeTui(mode: InteractiveMode): TUI {
  const ui = (mode as unknown as { ui: TUI }).ui;
  if (!ui || typeof ui.start !== "function" || typeof ui.requestRender !== "function") {
    throw new Error("Unsupported Pi native TUI: expected the Pi 1.3.0 InteractiveMode.ui contract");
  }
  return ui;
}

let nativeVersionChecked = false;
export function checkNativeVersion(): void {
  if (nativeVersionChecked) return;
  const pkg = JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8")) as { version: string };
  if (!supportedPiVersion(pkg.version)) throw new Error(`pi-agents requires Pi ${PI_VERSION_RANGE}; found ${pkg.version}`);
  nativeVersionChecked = true;
}

export class NativeSessionHost extends NativeFleet {
  declare readonly sessions: Map<string, Session>;
  private boardOpen = false;
  /** Host-owned dialogs (board, directory picker) never count as a session needing input. */
  private hostPrompts = 0;
  private creating = false;
  private closing = false;
  private closeTask?: Promise<void>;
  get isClosing(): boolean { return this.closing; }
  private readonly creationKeys = new Set<string>();
  private readonly creations = new Set<Promise<Session>>();
  private readonly stops = new Map<string, Promise<void>>();
  protected override navigationAllowed(): boolean { return !this.closing; }
  private readonly inactivity = new Map<string, Promise<void>>();
  private readonly featureCleanup: (() => void | Promise<void>)[] = [];
  private featuresStarted = false;
  prepareMode?: (mode: InteractiveMode, record: Session) => void;
  onExit?: () => Promise<void>;
  onLeave?: () => Promise<void>;
  onRestart?: () => Promise<void>;
  onStop?: () => Promise<void>;
  onRecover?: (record: Session, ctx: ExtensionContext) => Promise<void>;

  constructor(
    readonly agentDir: string,
    readonly terminalFactory: () => Terminal,
    readonly config: Readonly<Config> = Object.freeze(loadConfig(agentDir)),
    readonly features: readonly SessionFeature[] = [],
  ) {
    super();
    const ids = features.map((feature) => feature.id);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate session feature ID");
    this.onChange = () => {
      if (!this.closing) for (const feature of this.features) feature.changed?.(this);
    };
  }

  startFeatures(): void {
    if (this.featuresStarted || this.closing) return;
    this.featuresStarted = true;
    for (const feature of this.features) {
      const cleanup = feature.start?.(this);
      if (cleanup) this.featureCleanup.push(cleanup);
    }
  }

  async refreshFeatures(): Promise<void> {
    for (const feature of this.features) await feature.refresh?.(this);
  }

  async findHistory(path: string) {
    for (const feature of this.features) {
      const history = await feature.history?.(this, path);
      if (history) return history;
    }
    return undefined;
  }

  isHostPrompt(record: LiveSession, kind: string): boolean {
    return this.hostPrompts > 0 && record.id === this.activeId && kind === "custom";
  }

  bind(record: Session, ctx: ExtensionContext): void {
    record.context = ctx;
    record.cwd = ctx.cwd;
    record.name = ctx.sessionManager.getSessionName() || (record.id === "home" ? "Home" : record.name || basename(ctx.cwd));
    record.removeInput?.();
    record.removeInput = ctx.ui.onTerminalInput((data) => {
      if (record.id !== this.activeId || this.boardOpen || this.creating || this.closing) return;
      for (const feature of this.features) {
        const result = feature.input?.(this, record, ctx, data);
        if (result) return result;
      }
      return;
    });
    this.onChange();
  }

  settled(record: Session, ctx: ExtensionContext): void {
    this.event(record, "settled");
    if (!this.closing) for (const feature of this.features) feature.settled?.(this, record, ctx);
  }

  async cycle(direction: number): Promise<void> {
    const rows = [...this.sessions.values()].filter(isNavigable);
    if (rows.length < 2) return;
    const index = rows.findIndex((r) => r.id === this.activeId);
    const next = rows[(index + direction + rows.length) % rows.length];
    if (next) await this.activate(next.id);
  }

  async open(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) throw new Error("/agents requires native interactive Pi");
    if (this.boardOpen || this.creating || this.closing) return;
    this.boardOpen = true;
    this.hostPrompts++;
    let action: BoardAction | undefined;
    try {
      await this.refreshFeatures();
      if (this.closing) return;
      action = await ctx.ui.custom<BoardAction | undefined>((ui, theme, _keys, done) => {
        return new CommandCenter(this, theme, () => ui.requestRender(), done, () => ui.terminal.rows, this.config.boardFullscreen);
      }, { overlay: true, overlayOptions: () => {
        const view = this.sessions.get(this.activeId)?.view;
        const size = commandCenterSize(view?.ui.terminal.columns ?? 80, view?.ui.terminal.rows ?? 24, this.config.boardFullscreen);
        return { width: size.width, maxHeight: size.height, anchor: "center", row: "50%", col: "50%" };
      } });
    } finally {
      this.boardOpen = false;
      this.hostPrompts--;
    }
    if (action?.kind === "switch") {
      const record = this.sessions.get(action.id);
      if (record && !record.view) await this.onRecover?.(record, ctx);
      else await this.activate(action.id);
    }
    // Ctrl+N starts a session in the directory being viewed; Ctrl+P picks another one.
    if (action?.kind === "new") await this.createFromUI(ctx, ctx.cwd);
    if (action?.kind === "pick") await this.createFromUI(ctx);
    if (action?.kind === "exit") await this.onExit?.();
    if (action?.kind === "leave") await this.onLeave?.();
    if (action?.kind === "abort") await this.abort(action.id);
    if (action?.kind === "stop") {
      const row = this.sessions.get(action.id);
      if (action.id === "home") { await this.onExit?.(); return; }
      const message = `Stop ${row?.name}? This aborts its run and disposes its runtime. Switching never stops a session.`;
      if (row && await ctx.ui.confirm("Stop native session?", message)) {
        await this.stop(action.id);
      }
    }
  }

  async createFromUI(ctx: ExtensionContext, directory?: string): Promise<void> {
    if (this.creating) return;
    this.creating = true;
    try {
      const entered = directory ?? await this.pickDirectory(ctx);
      if (entered === undefined) return;
      await this.createAt(ctx, entered);
    } finally {
      this.creating = false;
    }
  }

  /** Open a managed session in a directory the user chose, resolving `~` and relative paths. */
  async createAt(ctx: ExtensionContext, directory: string): Promise<void> {
    const cwd = await realpath(expandDirectory(directory, ctx.cwd));
    if (!(await stat(cwd)).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
    const trusted = cwd === ctx.cwd ? ctx.isProjectTrusted() : new ProjectTrustStore(this.agentDir).get(cwd) === true;
    if (!trusted && hasTrustRequiringProjectResources(cwd)) {
      ctx.ui.notify(`Project resources are untrusted in ${cwd}; only trusted/global resources will load. Trust configuration is unchanged.`, "info");
    }
    const record = await this.create(cwd, trusted, ctx);
    await this.activate(record.id);
  }

  /** A searchable directory choice: recent projects, the typed path, and filesystem completion. */
  private async pickDirectory(ctx: ExtensionContext): Promise<string | undefined> {
    const projects: PickerProject[] = [...this.sessions.values()]
      .filter((row) => !row.stopping)
      .map((row) => ({ cwd: row.cwd, name: row.name, activity: row.activity, lastActivityAt: row.lastActivityAt ?? 0 }));
    this.hostPrompts++;
    try {
      return await ctx.ui.custom<string | undefined>((ui, theme, _keys, done) =>
        new PathPicker(projects, ctx.cwd, theme, () => ui.requestRender(), done, () => ui.terminal.rows, this.config.boardFullscreen), {
        overlay: true,
        overlayOptions: () => {
          const view = this.sessions.get(this.activeId)?.view;
          const size = commandCenterSize(view?.ui.terminal.columns ?? 80, view?.ui.terminal.rows ?? 24, this.config.boardFullscreen);
          return { width: size.width, maxHeight: size.height, anchor: "center", row: "50%", col: "50%" };
        },
      });
    } finally {
      this.hostPrompts--;
    }
  }

  /**
   * The session a frontend should show for its own directory: a live one for that
   * directory, a saved one resumed in place, or a new one. Never a duplicate.
   * A saved history that cannot be opened keeps its failed row and yields a usable
   * fallback session plus the reason, so the attachment can show what happened.
   */
  async ensureSessionForCwd(cwd: string, isTrusted: (directory: string) => boolean): Promise<LaunchSessionResult> {
    const rows = [...this.sessions.values()].filter((row) => row.cwd === cwd);
    const live = rows.filter(isNavigable).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    if (live[0]) return { id: live[0].id };
    const saved = rows.filter((row) => !row.view && !row.stopping && row.sessionFile)
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
    if (saved?.sessionFile) {
      try {
        assertManagedFile(join(this.agentDir, "sessions"), saved.sessionFile);
        const resumed = await this.create(cwd, isTrusted(cwd), undefined, {
          id: saved.id, name: saved.name, sessionFile: saved.sessionFile, sourceFile: saved.sourceFile, draft: saved.draft,
        });
        return { id: resumed.id };
      } catch (error) {
        this.fail(saved, error);
        const reason = error instanceof Error ? error.message : String(error);
        const created = await this.create(cwd, isTrusted(cwd));
        return {
          id: created.id,
          launchError: `Could not resume saved session ${saved.name} in ${cwd}: ${reason}. Showing a new session for this directory; the saved entry is marked failed.`,
        };
      }
    }
    const created = await this.create(cwd, isTrusted(cwd));
    return { id: created.id };
  }

  create(cwd: string, trusted: boolean, parent?: ExtensionContext, options: NativeSessionOptions = {}): Promise<Session> {
    const keys = [options.id ? `id:${options.id}` : undefined, options.sessionFile ? `file:${resolve(options.sessionFile)}` : undefined].filter((key): key is string => key !== undefined);
    if (keys.some((key) => this.creationKeys.has(key))) return Promise.reject(new Error("Session creation is already in progress"));
    for (const key of keys) this.creationKeys.add(key);
    const task = this.createSession(cwd, trusted, parent, options);
    this.creations.add(task);
    void task.finally(() => {
      this.creations.delete(task);
      for (const key of keys) this.creationKeys.delete(key);
    }).catch(() => {});
    return task;
  }

  private async createSession(cwd: string, trusted: boolean, parent?: ExtensionContext, options: NativeSessionOptions = {}): Promise<Session> {
    if (this.closing) throw new Error("The session host is closing");
    checkNativeVersion();
    if (options.sessionFile) {
      const existing = [...this.sessions.values()].find((row) => row.view && row.activity !== "stopped" && row.sessionFile && resolve(row.sessionFile) === resolve(options.sessionFile!));
      if (existing) return existing;
    }
    const id = options.id ?? randomUUID();
    if (this.sessions.get(id)?.runtime) throw new Error("Stop the existing failed runtime before retrying this session");
    const record: Session = { id, cwd, name: options.name ?? basename(cwd), activity: "ready", running: false, prompts: 0, unread: false, sessionFile: options.sessionFile, sourceFile: options.sourceFile, draft: options.draft, lastActivityAt: Date.now() };
    this.sessions.set(id, record);
    try {
      if (!(await stat(cwd)).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
      // Managed resumes require the daemon lifetime lock. Snapshot recovery forks
      // read-only source history to a distinct native session ID and directory.
      const encoded = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
      const sessionDir = join(this.agentDir, "sessions", encoded);
      privateDirectory(sessionDir);
      if (options.sessionFile && !existsSync(options.sessionFile)) throw new Error(`Managed history is no longer available: ${options.sessionFile}`);
      let manager = options.sourceFile && !options.sessionFile
        ? SessionManager.forkFrom(options.sourceFile, cwd, sessionDir)
        : options.sessionFile && existsSync(options.sessionFile)
          ? SessionManager.open(options.sessionFile, sessionDir, cwd)
          : SessionManager.create(cwd, sessionDir);
      record.sessionFile = manager.getSessionFile();
      // Pi normally delays its first disk write until an assistant message.
      // Managed sessions must also be resumable when they contain only a draft.
      // Persist the native manager's own header/entries, exclusively in our storage.
      if (record.sessionFile && !existsSync(record.sessionFile)) {
        const entries = [manager.getHeader(), ...manager.getEntries()];
        await writeFile(record.sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
        // Reopen through Pi so its persistence state knows the file exists;
        // otherwise its first assistant append would attempt another exclusive create.
        manager = SessionManager.open(record.sessionFile, sessionDir, cwd);
      }
      const factory: CreateAgentSessionRuntimeFactory = async (options) => {
        const loaded = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: trusted });
        const settingsManager = SettingsManager.inMemory(loaded.getSettings(), { projectTrusted: trusted });
        const services = await createAgentSessionServices({
          cwd: options.cwd, agentDir: options.agentDir, settingsManager,
          resourceLoaderOptions: {
            extensionFactories: [{ name: "pi-agents-native", factory: (pi) => install(pi, this, record) }],
          },
        });
        const result = await createAgentSessionFromServices({
          services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent,
          ...(parent?.model ? { model: parent.model } : {}),
          ...(parent?.thinkingLevel ? { thinkingLevel: parent.thinkingLevel } : {}),
          ...(parent?.scopedModels.length ? { scopedModels: [...parent.scopedModels] } : {}),
        });
        return { ...result, services, diagnostics: services.diagnostics };
      };
      const runtime = await createAgentSessionRuntime(factory, {
        cwd, agentDir: this.agentDir, sessionManager: manager,
        sessionStartEvent: { type: "session_start", reason: "startup" },
      });
      record.runtime = runtime;
      if (this.closing) throw new Error("The session host closed during session creation");
      const lease = new TerminalLease(this.terminalFactory());
      const mode = new InteractiveMode(runtime, { terminal: lease.terminal });
      const cancelPrompts = nativePromptCancellation(mode);
      record.mode = mode;
      this.prepareMode?.(mode, record);
      let started = false;
      let initialization: Promise<void> | undefined;
      let disposal: Promise<void> | undefined;
      const disposeNative = (): Promise<void> => {
        disposal ??= (async () => { mode.stop(); await runtime.dispose(); })();
        return disposal;
      };
      const host = this;
      const view: NativeView = {
        get ui() { return nativeTui(mode); },
        lease,
        cancelPrompts,
        async start() {
          if (started) { nativeTui(mode).start(); return; }
          if (!initialization) initialization = (async () => {
            try {
              await mode.init();
              if (host.closing || record.stopping) return;
              if (record.draft !== undefined) record.context?.ui.setEditorText(record.draft);
              started = true;
              // Keep native Pi's input loop alive, including all native slash commands.
              void mode.run().catch((error: unknown) => host.fail(record, error));
            } catch (error) {
              host.fail(record, error);
              record.stopping = true;
              try {
                record.removeInput?.();
                await disposeNative();
                record.view = undefined; record.runtime = undefined; record.mode = undefined;
                record.context = undefined; record.removeInput = undefined;
              } catch (cleanupError) {
                host.fail(record, new AggregateError([error, cleanupError], "Native initialization and cleanup failed"));
              } finally { record.stopping = false; host.onChange(); }
              throw error;
            }
          })();
          else nativeTui(mode).start();
          await initialization;
        },
        async dispose() {
          // A startup extension may still be completing after its dialog was
          // cancelled. It must finish before disposing the runtime it uses.
          cancelPrompts();
          try { await initialization; } catch { /* Initialization preserves its own failure. */ }
          await disposeNative();
        },
      };
      record.view = view;
      this.onChange();
      return record;
    } catch (error) {
      this.fail(record, error);
      record.stopping = true;
      try {
        record.removeInput?.(); await record.runtime?.dispose();
        record.view = undefined; record.runtime = undefined; record.mode = undefined;
        record.context = undefined; record.removeInput = undefined;
      }
      catch (cleanupError) { this.fail(record, new AggregateError([error, cleanupError], "Session creation and cleanup failed")); }
      finally {
        record.stopping = false;
        this.onChange();
      }
      throw error;
    }
  }

  async abort(id: string): Promise<void> {
    const record = this.sessions.get(id);
    if (!record?.runtime) throw new Error("Only managed live runs can be aborted. Recover saved history first.");
    const abort = record.runtime.session.abort();
    const resumePrompts = record.view?.cancelPrompts?.();
    try { await abort; } finally { resumePrompts?.(); }
  }

  waitForInactivity(id: string): Promise<void> { return this.inactivity.get(id) ?? Promise.resolve(); }

  /** Unload only hidden, settled sessions. Reopening resumes their managed file. */
  async deactivateIdle(now = Date.now(), timeout = this.config.autoInactive ? this.config.idleTimeoutMs : 0): Promise<void> {
    if (!timeout || this.closing) return;
    for (const record of this.sessions.values()) {
      if (this.closing) return;
      // A record whose disposal already started (explicit stop, or an earlier unload) must
      // not be disposed a second time from here.
      if (record.id === "home" || record.id === this.activeId || record.stopping || (record.pendingOperations ?? 0) > 0 || this.isChangingTerminal(record.id) || record.activity !== "ready" || record.running || record.prompts || !record.view || !record.lastActivityAt || now - record.lastActivityAt < timeout || this.inactivity.has(record.id)) continue;
      if (record.runtime && !record.runtime.session.isIdle) continue;
      const task = (async () => {
        record.draft = record.context?.ui.getEditorText() ?? record.draft;
        record.activity = "inactive";
        record.stopping = true;
        record.removeInput?.();
        try {
          await record.view?.dispose();
          record.view = undefined;
          record.mode = undefined;
          record.runtime = undefined;
          record.context = undefined;
          record.removeInput = undefined;
          record.activity = "inactive";
        } catch (error) { this.fail(record, error); }
        finally { record.stopping = false; this.onChange(); }
      })();
      this.inactivity.set(record.id, task);
      try { await task; } finally { this.inactivity.delete(record.id); }
    }
  }

  stop(id: string): Promise<void> {
    const pending = this.stops.get(id);
    if (pending) return pending;
    const task = this.stopSession(id);
    this.stops.set(id, task);
    void task.finally(() => this.stops.delete(id)).catch(() => {});
    return task;
  }

  private async stopSession(id: string): Promise<void> {
    if (this.closing) throw new Error("The session host is closing");
    if (id === "home") throw new Error("Use the exit menu to stop the host");
    await this.waitForInactivity(id);
    if (this.closing) throw new Error("The session host is closing");
    const record = this.sessions.get(id);
    if (!record || record.activity === "stopped") return;
    record.stopping = true;
    let resumePrompts: (() => void) | undefined;
    try {
      record.draft = record.context?.ui.getEditorText() ?? record.draft;
      const abort = record.runtime?.session.abort();
      // Initialization itself may await a dialog. Cancel before waiting for its
      // terminal handoff, with the native abort flag already set.
      resumePrompts = record.view?.cancelPrompts?.();
      if (abort) void abort.catch(() => {});
      await this.waitForNavigation();
      if (id === this.activeId) await this.activate("home");
      record.removeInput?.();
      await abort;
      if (record.view) await record.view.dispose();
      else await record.runtime?.dispose();
      // Disposal succeeded, so nothing may keep the dead native view, runtime, or mode
      // alive: host.close() and recovery must not touch or re-dispose them. Only the
      // resumable state (sessionFile, sourceFile, draft, lastError) is retained.
      record.view = undefined;
      record.runtime = undefined;
      record.mode = undefined;
      record.context = undefined;
      record.removeInput = undefined;
      record.activity = "stopped";
      record.running = false;
    } catch (error) {
      resumePrompts?.();
      this.fail(record, error);
      throw error;
    } finally {
      record.stopping = false;
    }
    this.onChange();
  }

  close(shuttingDownId?: string): Promise<void> {
    this.closeTask ??= this.closeSessions(shuttingDownId);
    return this.closeTask;
  }

  private async closeSessions(shuttingDownId?: string): Promise<void> {
    this.closing = true;
    const cleanups: Promise<void>[] = [];
    for (const cleanup of this.featureCleanup.splice(0).reverse()) {
      try { const result = cleanup(); if (result) cleanups.push(result); } catch (error) { console.error("Session feature cleanup failed", error); }
    }
    const interruptions = new Map<Session, { wasUnsettled: boolean; abort?: Promise<void> }>();
    for (const row of this.sessions.values()) {
      if (row.id === shuttingDownId || row.activity === "stopped" || this.stops.has(row.id)) continue;
      const wasUnsettled = row.running || row.prompts > 0 || (row.pendingOperations ?? 0) > 0;
      const abort = row.runtime?.session.abort();
      if (abort) void abort.catch(() => {});
      interruptions.set(row, { wasUnsettled, abort });
      row.view?.cancelPrompts?.();
    }
    await Promise.allSettled([...this.creations, ...this.stops.values(), ...cleanups]);
    await this.waitForNavigation();
    await Promise.all(this.inactivity.values());
    for (const row of this.sessions.values()) {
      row.removeInput?.();
      if (row.id === shuttingDownId || row.activity === "stopped") continue;
      if (row.view?.lease.enabled) row.view.ui.stop();
      if (row.view) row.view.lease.enabled = false;
      try {
        row.draft = row.context?.ui.getEditorText() ?? row.draft;
        const interruption = interruptions.get(row);
        const wasUnsettled = interruption?.wasUnsettled ?? (row.running || row.prompts > 0);
        await interruption?.abort;
        if (row.view) await row.view.dispose();
        else await row.runtime?.dispose();
        // A host shutdown is not a user stop. Settled and failed sessions keep the state a
        // restart can restore them into; only runs aborted by the shutdown are recorded as
        // stopped, so restarting the host does not mark every session explicitly stopped.
        if (row.view && wasUnsettled && row.activity !== "failed") row.activity = "stopped";
        row.view = undefined; row.runtime = undefined; row.mode = undefined;
        row.removeInput = undefined; row.running = false; row.prompts = 0;
      } catch (error) { this.fail(row, error); }
      finally { row.context = undefined; }
    }
  }
}

function install(pi: ExtensionAPI, host: NativeSessionHost, record: Session): void {
  pi.registerCommand("agents", {
    description: "Native session command center; /agents new [directory]",
    handler: async (args, ctx) => {
      try {
        const command = args.trim();
        if (command === "leave") await host.onLeave?.();
        else if (command === "stop") await host.onStop?.();
        else if (command === "status") ctx.ui.notify(`${host.sessions.size} sessions · ${countUnsettled([...host.sessions.values()])} running or waiting`, "info");
        else if (command === "takeover") ctx.ui.notify("This terminal already owns the managed session view.", "info");
        else if (command === "restart") await host.onRestart?.();
        else if (command === "new" || command.startsWith("new ")) await host.createFromUI(ctx, command.slice(4).trim() || undefined);
        else if (command) ctx.ui.notify("Usage: /agents [new [directory] | status | stop | takeover | leave | restart].", "info");
        else await host.open(ctx);
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.on("session_start", (_event, ctx) => { host.bind(record, ctx); });
  pi.on("session_info_changed", (_event, ctx) => { host.bind(record, ctx); });
  pi.on("agent_start", () => { host.event(record, "start"); });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant" && event.message.stopReason === "error") {
      host.fail(record, event.message.errorMessage || "Agent run failed; see the native transcript");
    }
  });
  pi.on("agent_settled", (_event, ctx) => { host.settled(record, ctx); });
  pi.on("ui_prompt_start", (event) => {
    if (!host.isHostPrompt(record, event.kind)) host.event(record, "prompt-start");
  });
  pi.on("ui_prompt_end", (event) => {
    if (!host.isHostPrompt(record, event.kind)) host.event(record, "prompt-end");
  });
  // Native replacement tears down a live runtime and can open a second writer.
  // Navigation and creation must go through the fleet in pi-agents.
  pi.on("session_before_switch", (_event, ctx) => {
    ctx.ui.notify("Use /agents to switch live sessions or /agents new to create one.", "info");
    return { cancel: true };
  });
  pi.on("session_before_fork", (_event, ctx) => {
    ctx.ui.notify("Forking history is outside pi-agents; use /agents new.", "info");
    return { cancel: true };
  });
  pi.on("session_shutdown", async (event) => {
    record.removeInput?.();
    if (event.reason !== "reload" && !record.stopping && !host.isClosing) await host.close(record.id);
  });
}
