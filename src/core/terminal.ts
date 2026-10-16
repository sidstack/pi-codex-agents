import type { Terminal } from "@earendil-works/pi-tui";

/** Gate every terminal side effect, including background progress/title updates.
 * Methods must be bound to the original instance (ProcessTerminal has state).
 */
export class TerminalLease {
  enabled = false;
  readonly terminal: Terminal;
  private readonly status = new Map<string, unknown[]>();

  constructor(private readonly source: Terminal) {
    this.terminal = new Proxy(source, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (key === "setTitle" || key === "setProgress" || key === "setProgramStatus") {
            this.status.set(key, args);
          }
          if (this.enabled) return Reflect.apply(value, target, args);
          if (key === "drainInput") return Promise.resolve();
        };
      },
    });
  }

  pauseProgress(): void {
    if (this.enabled) this.source.setProgress(false);
  }

  /** Re-send the latest native status after the physical terminal restarts. */
  restore(): void {
    if (!this.enabled) return;
    for (const [key, args] of this.status) {
      const method: unknown = Reflect.get(this.terminal, key);
      if (typeof method === "function") Reflect.apply(method, this.terminal, args);
    }
  }
}
