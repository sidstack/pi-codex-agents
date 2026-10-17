import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { createJsonlReader, encodeJsonl } from "../src/core/jsonl.js";
import { connectNative, type NativeConnection } from "../src/pi/client.js";
import { attachTerminal } from "../src/pi/attachment.js";

/** How the fake host ends the attachment after answering attach/open. */
type Ending = "drop" | "garbage" | "detached" | "quit" | "stopped" | "attach-only" | "launch-error" | "startup-dialog" | "reject-attach";

interface FakeHost {
  socketPath: string;
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

const managed: string[] = [];
const hosts: FakeHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of managed.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A host that accepts the attachment and then ends it in the requested way. */
async function listenFakeHost(ending: Ending): Promise<FakeHost> {
  const root = mkdtempSync(join(tmpdir(), "pi-native-attachment-"));
  managed.push(root);
  const socketPath = join(root, "host.sock");
  const accepted: Socket[] = [];
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer((socket) => {
    accepted.push(socket);
    socket.on("error", () => {});
    let attachId: unknown;
    const reader = createJsonlReader((raw) => {
      const message = raw as Record<string, unknown>;
      requests.push(message);
      if (socket.destroyed) return;
      if (ending === "reject-attach") {
        socket.write(encodeJsonl({ type: "response", id: message.id, success: false, error: "Native host is already attached" }));
        return;
      }
      if (ending === "startup-dialog") {
        if (message.type === "attach") {
          attachId = message.id;
          socket.write(encodeJsonl({ type: "terminal", method: "write", args: ["Startup confirmation"] }));
        } else if (message.type === "input" && message.data === "\r") {
          socket.write(encodeJsonl({ type: "response", id: attachId, success: true, result: {} }));
          socket.write(encodeJsonl({ type: "detached", reason: "Startup completed" }), () => socket.end());
        }
        return;
      }
      const answer = encodeJsonl({ type: "response", id: message.id, success: true, result: message.type === "attach" && ending === "launch-error"
        ? { answered: "attach", launchError: "Could not open a session for /tmp/gone: Not a directory" }
        : { answered: String(message.type) } });
      if (message.type !== "open") {
        socket.write(answer);
        // A session-only attachment never sends open, so these hosts detach on attach.
        if (ending === "launch-error" || ending === "attach-only") socket.write(encodeJsonl({ type: "detached", reason: "Returned to Pi." }), () => socket.end());
        return;
      }
      if (ending === "detached" || ending === "launch-error" || ending === "attach-only") { socket.write(answer); socket.write(encodeJsonl({ type: "detached", reason: "Left the session view; sessions kept running." }), () => socket.end()); }
      else if (ending === "quit") { socket.write(answer); socket.write(encodeJsonl({ type: "detached", reason: "Host is quitting the frontend Pi.", quitFrontend: true }), () => socket.end()); }
      else if (ending === "stopped") { socket.write(answer); socket.write(encodeJsonl({ type: "stopped", quitFrontend: true, restart: true }), () => socket.end()); }
      else if (ending === "garbage") { socket.write(answer); socket.write("not a native record\n", () => socket.destroy()); }
      // Transport loss: the open response is flushed first, then the socket dies without a verdict.
      else { socket.write(answer, () => { setTimeout(() => socket.destroy(), 30); }); }
    });
    socket.on("data", (chunk) => reader.write(chunk));
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); done(); });
  });
  return {
    socketPath,
    requests,
    close: async () => {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((done) => { server.close(() => done()); });
    },
  };
}

function fakeTerminal(): { terminal: Terminal; calls: string[] } {
  const calls: string[] = [];
  const terminal = {
    columns: 90,
    rows: 24,
    kittyProtocolActive: false,
    start: (onInput: (data: string) => void, onResize: () => void) => { calls.push(`start:${typeof onInput}:${typeof onResize}`); },
    stop: () => { calls.push("stop"); },
    setProgress: (value: unknown) => { calls.push(`setProgress:${String(value)}`); },
  } as unknown as Terminal;
  return { terminal, calls };
}

async function runAttachment(ending: Ending, options: Parameters<typeof attachTerminal>[2] = {}): Promise<{ result?: Awaited<ReturnType<typeof attachTerminal>>; error?: Error; calls: string[]; requests: Record<string, unknown>[]; connection: NativeConnection }> {
  const host = await listenFakeHost(ending);
  hosts.push(host);
  const { terminal, calls } = fakeTerminal();
  const connection = await connectNative(host.socketPath);
  const outcome: { result?: Awaited<ReturnType<typeof attachTerminal>>; error?: Error } = {};
  try {
    outcome.result = await attachTerminal(connection, terminal, options);
  } catch (error) {
    outcome.error = error instanceof Error ? error : new Error(String(error));
  }
  return { ...outcome, calls, requests: host.requests, connection };
}

describe("terminal attachment", () => {
  it("renders and answers a startup dialog while the attach response is pending", async () => {
    const host = await listenFakeHost("startup-dialog");
    hosts.push(host);
    const connection = await connectNative(host.socketPath);
    const { terminal, calls } = fakeTerminal();
    let input: ((data: string) => void) | undefined;
    terminal.start = (onInput) => { calls.push("start"); input = onInput; };
    terminal.write = (text) => {
      expect(text).toBe("Startup confirmation");
      expect(input).toBeDefined();
      calls.push("dialog");
      input!("\r");
    };

    const result = await attachTerminal(connection, terminal, { openBoard: false, launchCwd: "/tmp/project" });

    expect(result.reason).toBe("Startup completed");
    expect(calls).toEqual(["start", "dialog", "setProgress:false", "stop"]);
    expect(host.requests.map((message) => message.type)).toEqual(["attach", "input"]);
  });

  it("hands the physical terminal back when attachment is refused", async () => {
    const outcome = await runAttachment("reject-attach");

    expect(outcome.error?.message).toContain("already attached");
    expect(outcome.calls).toEqual(["start:function:function", "setProgress:false", "stop"]);
    expect(outcome.connection.socket.destroyed).toBe(true);
  });

  it("rejects an unexpected host close instead of reporting a clean return", async () => {
    const outcome = await runAttachment("drop");

    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error?.message).toContain("without detaching or stopping");
    expect(outcome.error?.message).toContain("host may still be running sessions");
    expect(outcome.error?.message).toContain("/agents status");
    expect(outcome.result).toBeUndefined();

    // The physical terminal is always handed back to Pi, and the dead socket is cleaned up.
    expect(outcome.calls).toEqual(["start:function:function", "setProgress:false", "stop"]);
    expect(outcome.connection.socket.destroyed).toBe(true);
    expect(outcome.requests.map((message) => message.type)).toEqual(["attach", "open"]);
  });

  it("reports the transport failure that killed the attachment", async () => {
    const outcome = await runAttachment("garbage");

    expect(outcome.error?.message).toContain("without detaching or stopping (Malformed native host response)");
    expect(outcome.error?.cause).toBeInstanceOf(Error);
    expect(outcome.calls).toEqual(["start:function:function", "setProgress:false", "stop"]);
  });

  it("resolves an explicit detach with the host reason and keeps sessions running", async () => {
    const outcome = await runAttachment("detached");

    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual({
      reason: "Left the session view; sessions kept running.",
      quitFrontend: false,
      restartHost: false,
    });
    expect(outcome.calls).toEqual(["start:function:function", "setProgress:false", "stop"]);
  });

  it("resolves an explicit detach that ends the frontend Pi", async () => {
    const outcome = await runAttachment("quit");

    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual({
      reason: "Host is quitting the frontend Pi.",
      quitFrontend: true,
      restartHost: false,
    });
  });

  it("resolves an explicit host stop with the restart choice", async () => {
    const outcome = await runAttachment("stopped");

    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual({
      reason: "Managed sessions stopped. Returned to Pi.",
      quitFrontend: true,
      restartHost: true,
    });
    expect(outcome.calls).toEqual(["start:function:function", "setProgress:false", "stop"]);
  });

  it("attaches a session view without requesting the command center", async () => {
    const outcome = await runAttachment("attach-only", { openBoard: false, launchCwd: "/tmp/project" });

    expect(outcome.error).toBeUndefined();
    // No open request: attaching alone shows the session.
    expect(outcome.requests.map((message) => message.type)).toEqual(["attach"]);
    expect(outcome.requests[0]).toMatchObject({ launchCwd: "/tmp/project", takeover: false, columns: 90, rows: 24 });
    expect(outcome.result).toEqual({ reason: "Returned to Pi.", quitFrontend: false, restartHost: false });
  });

  it("reports a launch failure the host answered with", async () => {
    const outcome = await runAttachment("launch-error", { openBoard: false, launchCwd: "/tmp/gone" });

    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.launchError).toContain("Could not open a session for /tmp/gone");
  });
});
