import { existsSync } from "node:fs";
import { readPrivateJSON } from "../core/security.js";
import { writeNativeRegistry } from "../core/storage.js";

export interface WorkerRecord {
  id: string; parent: string; name: string; cwd: string; role: string;
  state: "starting" | "running" | "completed" | "failed" | "stopped";
  createdAt: string; error?: string;
}
export interface AgentMessage { id: number; from: string; to: string; kind: string; text: string; createdAt: string; }
interface State { version: 1; sequence: number; workers: WorkerRecord[]; messages: AgentMessage[]; }

/** Durable bounded mail, never a queue of model requests to replay after a crash. */
export class DelegationStore {
  readonly workers = new Map<string, WorkerRecord>();
  private messages: AgentMessage[] = [];
  private sequence = 0;
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    const state = readPrivateJSON(path) as State;
    if (state.version !== 1 || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !Array.isArray(state.workers) || state.workers.length > 512 || !Array.isArray(state.messages) || state.messages.length > 256) throw new Error("Invalid delegation state");
    for (const worker of state.workers) {
      if (!worker || typeof worker.id !== "string" || typeof worker.parent !== "string" || typeof worker.name !== "string" || typeof worker.cwd !== "string" || typeof worker.role !== "string" || typeof worker.createdAt !== "string" || worker.id.length > 150 || worker.parent.length > 150 || worker.name.length > 100 || worker.cwd.length > 4096 || worker.role.length > 20 || worker.createdAt.length > 100 || !["starting", "running", "completed", "failed", "stopped"].includes(worker.state) || this.workers.has(worker.id) || (worker.error !== undefined && (typeof worker.error !== "string" || worker.error.length > 4000))) throw new Error("Invalid saved worker");
      if (worker.state === "starting" || worker.state === "running") { worker.state = "failed"; worker.error = "Previous host ended; task was not replayed. Review history and explicitly send new work."; }
      this.workers.set(worker.id, worker);
    }
    let previous = 0;
    for (const message of state.messages) {
      if (!message || !Number.isSafeInteger(message.id) || message.id <= previous || message.id > state.sequence || typeof message.from !== "string" || typeof message.to !== "string" || typeof message.kind !== "string" || typeof message.text !== "string" || message.text.length > 4000 || typeof message.createdAt !== "string" || message.from.length > 150 || message.to.length > 150 || message.kind.length > 30 || message.createdAt.length > 100) throw new Error("Invalid saved agent message");
      previous = message.id;
    }
    this.messages = state.messages; this.sequence = state.sequence;
  }
  save(): void {
    writeNativeRegistry(this.path, { version: 1, sequence: this.sequence, workers: [...this.workers.values()], messages: this.messages }, 4 * 1024 * 1024);
    for (const listener of [...this.listeners]) listener();
  }
  send(from: string, to: string, kind: string, text: string): AgentMessage {
    const message = { id: ++this.sequence, from, to, kind, text: text.slice(0, 4000), createdAt: new Date().toISOString() };
    this.messages.push(message);
    if (this.messages.length > 256) this.messages.shift();
    this.save(); return message;
  }
  inbox(caller: string, after: number) {
    const messages = this.messages.filter((message) => message.to === caller && message.id > after).slice(0, 20);
    const oldest = this.messages[0]?.id ?? this.sequence + 1;
    return { caller, messages, nextCursor: messages.at(-1)?.id ?? this.sequence, truncated: after > 0 && after < oldest - 1 };
  }
  wait(caller: string, after: number, timeoutMs: number): Promise<ReturnType<DelegationStore["inbox"]>> {
    const immediate = this.inbox(caller, after);
    if (immediate.messages.length || !timeoutMs) return Promise.resolve(immediate);
    if (this.waiters.size >= 64) return Promise.reject(new Error("Too many inbox waits"));
    return new Promise((done) => {
      const finish = () => { clearTimeout(timer); this.listeners.delete(changed); this.waiters.delete(finish); done(this.inbox(caller, after)); };
      const changed = () => { if (this.inbox(caller, after).messages.length) finish(); };
      const timer = setTimeout(finish, timeoutMs);
      this.listeners.add(changed); this.waiters.add(finish);
    });
  }
  close(): void { for (const finish of [...this.waiters]) finish(); }
}
