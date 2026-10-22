import { existsSync, lstatSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { processIdentity } from "./core/storage.js";

export interface Config {
  historyImport: boolean;
  autoName: boolean;
  autoAttach: boolean;
  resumeLastSession: boolean;
  leftArrowEntry: boolean;
  commandCenterShortcut: boolean;
  sessionCycling: boolean;
  showStatus: boolean;
  autoInactive: boolean;
  autoUpdateHost: boolean;
  boardFullscreen: boolean;
  idleTimeoutMs: number;
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  autoName: true, historyImport: true, autoAttach: true, resumeLastSession: false, leftArrowEntry: true, commandCenterShortcut: true,
  sessionCycling: true, showStatus: true, autoInactive: true, autoUpdateHost: true,
  boardFullscreen: true, idleTimeoutMs: 3_600_000,
});

/** The package names its state directory. `pi-agents` is the pre-rename directory, still
 * read so an existing install keeps working until its state is moved by prepareAppDirectory. */
export const APP_DIR_NAME = "pi-codex-agents";
export const LEGACY_APP_DIR_NAME = "pi-agents";

/** First set environment variable, so renamed `PI_CODEX_AGENTS_*` names win over the
 * shorter `PI_AGENTS_*` names an older frontend or launcher may still export. */
function envName(names: string[]): string | undefined {
  for (const name of names) if (process.env[name]) return name;
  return undefined;
}

function envPath(...names: string[]): string | undefined {
  const name = envName(names);
  return name ? process.env[name] : undefined;
}

export function appDirectory(agentDir = getAgentDir()): string {
  const override = envPath("PI_CODEX_AGENTS_DIR", "PI_AGENTS_DIR");
  if (override) return resolve(override);
  const current = join(agentDir, APP_DIR_NAME);
  const legacy = join(agentDir, LEGACY_APP_DIR_NAME);
  // Until the state actually moves, use the directory that holds it.
  if (!existsSync(current) && existsSync(legacy)) return resolve(legacy);
  return resolve(current);
}

/** Host state may live outside the app directory; both builds accept either name. */
export function nativeHostDirectory(agentDir = getAgentDir()): string {
  return resolve(envPath("PI_CODEX_AGENTS_NATIVE_DIR", "PI_AGENTS_NATIVE_DIR") ?? join(appDirectory(agentDir), "host"));
}

/** The host writes its lifetime lock next to its socket, so a live lock names a host that
 * still owns this directory. Returns its PID, or undefined when nothing is using it. */
function liveHost(directory: string): number | undefined {
  try {
    const owner = JSON.parse(readFileSync(join(directory, "host.lock"), "utf8")) as { pid?: number; identity?: string };
    if (Number.isInteger(owner.pid) && owner.identity && processIdentity(owner.pid) === owner.identity) return owner.pid;
  } catch { /* No readable lock: nothing claims this directory. */ }
  return undefined;
}

export interface AppDirectoryState { directory: string; notice?: string; }

/** One-time move of pre-rename state to the package name, and the directory to use now.
 * A directory an explicit environment variable selects is never moved, and a directory a
 * running host still owns is left alone: the caller keeps using it and reports why. */
export function prepareAppDirectory(agentDir = getAgentDir()): AppDirectoryState {
  if (envPath("PI_CODEX_AGENTS_DIR", "PI_AGENTS_DIR")) return { directory: appDirectory(agentDir) };
  const to = resolve(join(agentDir, APP_DIR_NAME));
  const from = resolve(join(agentDir, LEGACY_APP_DIR_NAME));
  if (!existsSync(from)) return { directory: to };
  const info = lstatSync(from);
  if (info.isSymbolicLink()) throw new Error(`Symlinked pi-codex-agents migration source: ${from}`);
  if (!info.isDirectory() || (process.getuid !== undefined && info.uid !== process.getuid())) throw new Error(`Unsafe pi-codex-agents migration source: ${from}`);
  if (realpathSync(from) !== from) throw new Error(`Symlinked pi-codex-agents migration source: ${from}`);
  if (existsSync(to)) return { directory: to, notice: `Both ${LEGACY_APP_DIR_NAME} and ${APP_DIR_NAME} hold state under ${agentDir}; using ${to}. Remove the old directory once nothing needs it.` };
  const holder = liveHost(nativeHostDirectory(agentDir)) ?? liveHost(join(from, "host"));
  if (holder) return { directory: from, notice: `The agent host (PID ${holder}) still uses ${from}. Run /agents stop and restart Pi to move its state to ${to}.` };
  renameSync(from, to);
  return { directory: to, notice: `Moved agent state to ${to}.` };
}

export function loadConfig(agentDir = getAgentDir()): Config {
  const path = join(appDirectory(agentDir), "config.json");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") raw = {};
    else throw new Error(`Cannot read pi-codex-agents config at ${path}: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pi-codex-agents config must be an object");
  const config = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(config, key)) throw new Error(`Unknown pi-codex-agents config option: ${key}`);
    if (key === "idleTimeoutMs") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("idleTimeoutMs must be a non-negative integer");
      config.idleTimeoutMs = value;
    } else {
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
      (config as unknown as Record<string, unknown>)[key] = value;
    }
  }
  const idleName = envName(["PI_CODEX_AGENTS_IDLE_MS", "PI_AGENTS_IDLE_MS"]);
  if (idleName !== undefined) {
    const value = Number(process.env[idleName]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${idleName} must be a non-negative integer`);
    config.idleTimeoutMs = value;
  }
  return config;
}
