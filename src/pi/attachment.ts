import type { Terminal } from "@earendil-works/pi-tui";
import type { NativeConnection } from "./client.js";

export interface AttachOptions {
  /** Move the terminal here from another frontend that already holds it. */
  takeover?: boolean;
  /** Show the command center after attaching. Default true. */
  openBoard?: boolean;
  /** The frontend's own directory, so the host can show a session for it. */
  launchCwd?: string;
}

export interface AttachmentResult {
  reason: string;
  /** The host could not open a session for the frontend's own directory. */
  launchError?: string;
  /** The host chose an action that must also end the frontend Pi process. */
  quitFrontend: boolean;
  /** The host replaced itself; the frontend must start the current build and reconnect. */
  restartHost: boolean;
}

const METHODS = new Set(["write", "moveBy", "hideCursor", "showCursor", "clearLine", "clearFromCursor", "clearScreen", "setTitle", "setProgress", "setProgramStatus"]);

/** Temporarily lends the physical terminal to the persistent host. */
export async function attachTerminal(connection: NativeConnection, terminal: Terminal, options: AttachOptions = {}): Promise<AttachmentResult> {
  let started = false;
  let reason = "Returned to Pi. Managed sessions keep running.";
  let quitFrontend = false;
  let restartHost = false;
  // Only the host's own verdict ends an attachment. A socket that closes without one is
  // transport loss: the host may still be running sessions behind the dead connection.
  let verdict: "detached" | "stopped" | undefined;
  let transportError: Error | undefined;
  const buffered: Record<string, unknown>[] = [];
  const closed = new Promise<void>((done) => connection.socket.once("close", done));
  const noteTransportError = (error: Error): void => { transportError = error; };
  connection.socket.on("error", noteTransportError);
  const display = (message: Record<string, unknown>) => {
    if (message.type === "terminal" && typeof message.method === "string" && METHODS.has(message.method) && Array.isArray(message.args)) {
      const method: unknown = Reflect.get(terminal, message.method);
      if (typeof method === "function") Reflect.apply(method, terminal, message.args);
    } else if (message.type === "detached") {
      verdict = "detached";
      reason = String(message.reason ?? reason);
      quitFrontend = message.quitFrontend === true;
    } else if (message.type === "stopped") {
      verdict = "stopped";
      reason = "Managed sessions stopped. Returned to Pi.";
      quitFrontend = message.quitFrontend === true;
      restartHost = message.restart === true;
    }
  };
  connection.onEvent = (message) => { if (started) display(message); else buffered.push(message); };
  try {
    const attachment = await connection.request("attach", {
      columns: terminal.columns, rows: terminal.rows, kitty: terminal.kittyProtocolActive,
      takeover: options.takeover === true,
      ...(options.launchCwd ? { launchCwd: options.launchCwd } : {}),
    }) as { launchError?: unknown } | undefined;
    if (connection.socket.destroyed) throw new Error("Session host disconnected during attachment");
    terminal.start((data) => connection.send({ type: "input", data, kitty: terminal.kittyProtocolActive }),
      () => connection.send({ type: "resize", columns: terminal.columns, rows: terminal.rows, kitty: terminal.kittyProtocolActive }));
    started = true;
    for (const message of buffered) display(message);
    buffered.length = 0;
    // Attaching shows a session; the board is an explicit follow-up request.
    if (options.openBoard !== false) await connection.request("open");
    await closed;
    if (!verdict) {
      throw new Error(
        `The agent host closed the terminal connection without detaching or stopping${transportError ? ` (${transportError.message})` : ""}. `
        + "The terminal is back in Pi, but the host may still be running sessions. Use /agents status to check it, "
        + "or reopen /agents to reconnect and restore saved histories.",
        transportError ? { cause: transportError } : undefined,
      );
    }
    return { reason, ...(typeof attachment?.launchError === "string" ? { launchError: attachment.launchError } : {}), quitFrontend, restartHost };
  } finally {
    connection.onEvent = () => {};
    connection.socket.off("error", noteTransportError);
    connection.socket.destroy();
    if (started) {
      try { terminal.setProgress(false); } finally { terminal.stop(); }
    }
  }
}
