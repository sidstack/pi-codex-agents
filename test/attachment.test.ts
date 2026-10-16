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
type Ending = "drop" | "garbage" | "detached" | "quit" | "stopped";

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
    const reader = createJsonlReader((raw) => {
      const message = raw as Record<string, unknown>;
      requests.push(message);
      if (socket.destroyed) return;
      const answer = encodeJsonl({ type: "response", id: message.id, success: true, result: { answered: String(message.type) } });
      if (message.type !== "open") { socket.write(answer); return; }
      if (ending === "detached") { socket.write(answer); socket.write(encodeJsonl({ type: "detached", reason: "Left the session view; sessions kept running." }), () => socket.end()); }
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

async function runAttachment(ending: Ending): Promise<{ result?: Awaited<ReturnType<typeof attachTerminal>>; error?: Error; calls: string[]; requests: Record<string, unknown>[]; connection: NativeConnection }> {
  const host = await listenFakeHost(ending);
  hosts.push(host);
  const { terminal, calls } = fakeTerminal();
  const connection = await connectNative(host.socketPath);
  const outcome: { result?: Awaited<ReturnType<typeof attachTerminal>>; error?: Error } = {};
  try {
    outcome.result = await attachTerminal(connection, terminal);
  } catch (error) {
    outcome.error = error instanceof Error ? error : new Error(String(error));
  }
  return { ...outcome, calls, requests: host.requests, connection };
}

describe("terminal attachment", () => {
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
});
