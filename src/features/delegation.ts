import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, isAbsolute } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { agentToolDefinitions } from "../agent-tools.js";
import { appDirectory } from "../config.js";
import type { NativeSessionHost, Session } from "../core/sessions.js";
import { DelegationStore, type WorkerRecord } from "./delegation-store.js";
import type { SessionFeature } from "./contracts.js";

const ROLES = ["implement", "review", "test", "research"] as const;
function text(input: Record<string, unknown>, key: string, max: number): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${key} must be a nonempty string of at most ${max} characters`);
  return value;
}
function cursor(input: Record<string, unknown>): number {
  const value = input.after ?? 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("after must be a non-negative integer");
  return value;
}

export function createDelegationFeature(): SessionFeature {
  let store: DelegationStore | undefined;
  let closed = false;
  const requests = new Set<Promise<unknown>>();
  const tasks = new Map<string, Promise<void>>();
  const reservations = new Set<string>();
  const preparations = new Map<string, Promise<void>>();
  const stopping = new Set<string>();
  function state(host: NativeSessionHost): DelegationStore {
    store ??= new DelegationStore(join(resolve(process.env.PI_AGENTS_NATIVE_DIR ?? join(appDirectory(host.agentDir), "host")), "delegation.json"));
    return store;
  }
  function capacity(host: NativeSessionHost): void {
    if (closed || host.isClosing) throw new Error("The session host is closing");
    const occupied = new Set([...reservations, ...[...host.sessions.values()].filter((row) => row.running || row.prompts > 0).map((row) => row.id)]);
    if (occupied.size >= host.config.maxWorkers) throw new Error(`Worker capacity ${host.config.maxWorkers} is occupied; wait for settlement and backend drain before retrying`);
  }
  function summary(host: NativeSessionHost, worker: WorkerRecord) {
    const row = host.sessions.get(worker.id);
    return { ...worker, activity: row?.activity ?? "inactive", running: row?.running ?? false, prompts: row?.prompts ?? 0, lastError: row?.lastError, sessionFile: row?.sessionFile };
  }
  function run(host: NativeSessionHost, record: Session, worker: WorkerRecord, prompt: string): void {
    const db = state(host);
    const runtime = record.runtime!;
    const task = (async () => {
      await record.view!.start();
      if (closed || host.isClosing || stopping.has(record.id) || record.stopping || record.runtime !== runtime) return;
      if (record.id !== host.activeId || !host.foregroundVisible) { record.view!.ui.stop(); record.view!.lease.enabled = false; }
      worker.state = "running"; db.save();
      await runtime.session.prompt(prompt);
      if (stopping.has(record.id) || closed) return;
      worker.state = record.lastError ? "failed" : "completed";
      worker.error = record.lastError?.slice(0, 4000);
      const assistant = [...runtime.session.messages].reverse().find((message) => message.role === "assistant");
      const result = assistant?.role === "assistant" ? assistant.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ").slice(0, 3500) : "Task settled; inspect the assigned artifacts and checks.";
      db.send(record.id, worker.parent, worker.state === "failed" ? "error" : "settled", worker.error ?? result);
    })().catch((error: unknown) => {
      worker.state = stopping.has(record.id) ? "stopped" : "failed";
      worker.error = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
      if (!closed) { host.fail(record, error); db.send(record.id, worker.parent, "error", worker.error); }
    }).finally(() => {
      record.pendingOperations = Math.max(0, (record.pendingOperations ?? 1) - 1);
      tasks.delete(record.id); reservations.delete(record.id);
      if (!closed) db.save();
    });
    tasks.set(record.id, task);
    void task.catch((error: unknown) => {
      worker.state = "failed"; worker.error = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
      host.fail(record, error);
    });
  }
  async function handle(host: NativeSessionHost, operation: string, input: Record<string, unknown>, caller: string): Promise<unknown> {
    const db = state(host), self = db.workers.get(caller);
    if (closed) throw new Error("Delegation is closed");
    const visible = [...db.workers.values()].filter((worker) => self ? worker.parent === self.parent : worker.parent === caller);
    if (operation === "list") return { caller, role: self ? "worker" : "supervisor", maxWorkers: host.config.maxWorkers, workers: visible.map((worker) => summary(host, worker)) };
    if (operation === "inbox") return db.inbox(caller, cursor(input));
    if (operation === "wait") {
      const timeout = input.timeoutMs ?? 25000;
      if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 0 || timeout > 25000) throw new Error("timeoutMs must be from 0 to 25000");
      return db.wait(caller, cursor(input), timeout);
    }
    if (operation === "send") {
      let to = text(input, "to", 150);
      if (to === "parent") { if (!self) throw new Error("This supervisor has no parent"); to = self.parent; }
      if (to !== self?.parent && !visible.some((worker) => worker.id === to)) throw new Error("Recipient is outside this worker group");
      const kind = input.kind ?? "message";
      if (typeof kind !== "string" || !["message", "question", "progress", "result"].includes(kind)) throw new Error("Invalid message kind");
      if (input.wake !== undefined && typeof input.wake !== "boolean") throw new Error("wake must be a boolean");
      if (self && input.wake === true) throw new Error("Workers send mailbox messages only; the supervisor controls model execution");
      const body = text(input, "text", 4000);
      const message = db.send(caller, to, kind, body);
      let delivery = "mailbox", wakeError: string | undefined;
      if (input.wake === true) {
        try {
          const record = host.sessions.get(to), worker = db.workers.get(to);
          if (!record?.runtime || !record.view || record.stopping || !worker) throw new Error("Worker is unloaded; open it in /agents before explicitly waking it");
          const prompt = `Supervisor message (${kind}, mailbox ${message.id}):\n${body}`;
          if (record.running) { await record.runtime.session.steer(prompt); delivery = "steering"; }
          else {
            capacity(host);
            if (tasks.has(to) || !record.runtime.session.isIdle) throw new Error("Worker is still settling; message remains in its mailbox");
            reservations.add(to); record.pendingOperations = (record.pendingOperations ?? 0) + 1; worker.state = "starting"; worker.error = undefined; db.save();
            run(host, record, worker, prompt); delivery = "started";
          }
        } catch (error) { wakeError = error instanceof Error ? error.message : String(error); }
      }
      return { message, delivery, ...(wakeError ? { wakeError } : {}) };
    }
    if (self) throw new Error("Workers cannot spawn or stop other sessions; report the need to the supervisor");
    if (operation === "stop") {
      const id = text(input, "sessionId", 150), worker = db.workers.get(id);
      if (!worker || worker.parent !== caller) throw new Error("Only an owned worker can be stopped");
      stopping.add(id); worker.state = "stopped"; db.save();
      try { await preparations.get(id); await host.stop(id); worker.state = "stopped"; db.save(); return summary(host, worker); }
      finally { stopping.delete(id); }
    }
    if (operation !== "spawn") throw new Error(`Unknown agent operation: ${operation}`);
    const name = text(input, "name", 100), cwd = text(input, "cwd", 4096), task = text(input, "task", 16000);
    if (!isAbsolute(cwd)) throw new Error("cwd must be absolute");
    const role = input.role ?? "implement";
    if (typeof role !== "string" || !ROLES.includes(role as typeof ROLES[number])) throw new Error("Invalid worker role");
    if ((input.provider === undefined) !== (input.model === undefined)) throw new Error("provider and model must be supplied together");
    const provider = input.provider === undefined ? undefined : text(input, "provider", 100);
    const modelId = input.model === undefined ? undefined : text(input, "model", 200);
    capacity(host);
    if (db.workers.size >= 512) throw new Error("Delegation metadata limit reached (512 workers)");
    const id = randomUUID(); reservations.add(id);
    const worker: WorkerRecord = { id, parent: caller, name, cwd, role, state: "starting", createdAt: new Date().toISOString() };
    db.workers.set(id, worker);
    let prepared = () => {};
    preparations.set(id, new Promise<void>((done) => { prepared = done; }));
    let owned: Session | undefined;
    try {
      db.save();
      const record = await host.create(cwd, new ProjectTrustStore(host.agentDir).get(cwd) === true, undefined, { id, name });
      owned = record; record.pendingOperations = (record.pendingOperations ?? 0) + 1;
      if (stopping.has(id)) throw new Error("Worker stopped while preparing");
      const session = record.runtime!.session;
      if (provider && modelId) {
        const model = session.modelRuntime.getModel(provider, modelId);
        if (!model) throw new Error(`Unknown worker model: ${provider}/${modelId}`);
        await session.setModel(model);
      }
      session.setThinkingLevel("medium"); session.setSessionName(name);
      const common = await readFile(fileURLToPath(new URL("../../skills/pi-session-worker/SKILL.md", import.meta.url)), "utf8");
      const policy = await readFile(fileURLToPath(new URL(`../../skills/pi-worker-${role}/SKILL.md`, import.meta.url)), "utf8");
      if (closed || host.isClosing || stopping.has(id)) throw new Error("Worker closed or stopped while preparing");
      const prompt = `Worker ${id}. Parent: ${caller}. Role: ${role}.\n${common}\n${policy}\nAssigned task:\n${task}`;
      run(host, record, worker, prompt);
      return { ...summary(host, worker), parentInbox: caller, thinking: "medium", model: session.model?.id, provider: session.model?.provider };
    } catch (error) {
      if (owned) owned.pendingOperations = Math.max(0, (owned.pendingOperations ?? 1) - 1);
      reservations.delete(id); if (worker.state !== "stopped") worker.state = "failed"; worker.error = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
      const row = host.sessions.get(id); if (row?.runtime && !host.isClosing) await host.stop(id).catch((cleanup: unknown) => host.fail(row, cleanup));
      db.save(); throw error;
    } finally { prepared(); preparations.delete(id); }
  }
  function dispatch(host: NativeSessionHost, operation: string, input: Record<string, unknown>, caller: string): Promise<unknown> {
    const request = handle(host, operation, input, caller);
    requests.add(request);
    void request.finally(() => requests.delete(request)).catch(() => {});
    return request;
  }
  return {
    id: "delegation",
    pending(host) { return [...reservations].filter((id) => { const row = host.sessions.get(id); return !row?.running && !row?.prompts && !row?.pendingOperations; }).length; },
    start() { return () => { closed = true; store?.close(); return Promise.allSettled([...requests, ...tasks.values()]).then(() => {}); }; },
    tools(host, record) { return agentToolDefinitions((operation, input) => dispatch(host, operation, input, record.id)); },
    request(host, operation, input, caller) { return operation.startsWith("agents.") ? dispatch(host, operation.slice(7), input, caller) : undefined; },
  };
}
