/** Gate every terminal side effect, including background progress/title updates.
 * Methods must be bound to the original instance (ProcessTerminal has state).
 */
export class TerminalLease {
    source;
    enabled = false;
    terminal;
    status = new Map();
    constructor(source) {
        this.source = source;
        this.terminal = new Proxy(source, {
            get: (target, key) => {
                const value = Reflect.get(target, key, target);
                if (typeof value !== "function")
                    return value;
                return (...args) => {
                    if (key === "setTitle" || key === "setProgress" || key === "setProgramStatus") {
                        this.status.set(key, args);
                    }
                    if (this.enabled)
                        return Reflect.apply(value, target, args);
                    if (key === "drainInput")
                        return Promise.resolve();
                };
            },
        });
    }
    pauseProgress() {
        if (this.enabled)
            this.source.setProgress(false);
    }
    /** Re-send the latest native status after the physical terminal restarts. */
    restore() {
        if (!this.enabled)
            return;
        for (const [key, args] of this.status) {
            const method = Reflect.get(this.terminal, key);
            if (typeof method === "function")
                Reflect.apply(method, this.terminal, args);
        }
    }
}
//# sourceMappingURL=terminal.js.map