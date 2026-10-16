import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlReader, encodeJsonl } from "../src/core/jsonl.js";
import { nativeDaemonPaths } from "../src/core/host.js";
import { connectNative, ensureNativeConnection } from "../src/pi/client.js";
import { PROTOCOL_VERSION } from "../src/version.js";

// ensureNativeConnection reads the daemon location from the environment, so every case
// runs against an isolated host directory and a throwaway socket.
const managed: string[] = [];
const ambient = ["PI_AGENTS_DIR", "PI_AGENTS_NATIVE_DIR", "PI_AGENTS_IDLE_MS", "PI_AGENTS_NATIVE_DAEMON"] as const;
const saved = new Map<string, string | undefined>();

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-native-client-"));
  managed.push(root);
  return root;
}

beforeEach(() => {
  for (const name of ambient) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(async () => {
  for (const name of ambient) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  for (const root of managed.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface FakeHost {
  accepted: Socket[];
  requests: Record<string, unknown>[];
  /** Resolves with the accepted socket whose peer (the frontend) went away. */
  peerClosed: Promise<Socket>;
  close(): Promise<void>;
}

/** A host that predates this build, speaks the current protocol, and owns nothing unsettled. */
function settledOldStatus(): Record<string, unknown> {
  return {
    version: "0.0.9", buildId: "a build from before this update", protocolVersion: PROTOCOL_VERSION,
    attached: false, capabilities: ["settledStop", "safeUpdate"],
    sessions: [{ id: "home", activity: "ready" }, { id: "settled", activity: "failed", running: false, prompts: 0 }],
  };
}

function listenFakeHost(socketPath: string, answerStop: "refuse" | "drop"): Promise<FakeHost> {
  const accepted: Socket[] = [];
  const requests: Record<string, unknown>[] = [];
  let resolveClosed: (socket: Socket) => void = () => {};
  const peerClosed = new Promise<Socket>((done) => { resolveClosed = done; });
  const server = createServer((socket) => {
    accepted.push(socket);
    socket.on("close", () => resolveClosed(socket));
    socket.on("error", () => {});
    const reader = createJsonlReader((raw) => {
      const message = raw as Record<string, unknown>;
      requests.push(message);
      if (socket.destroyed) return;
      if (message.type === "stop") {
        if (answerStop === "drop") { socket.destroy(); return; }
        socket.write(encodeJsonl({ type: "response", id: message.id, success: false, error: "the host refused the automatic stop" }));
        return;
      }
      const result = message.type === "status" ? settledOldStatus() : { answered: String(message.type) };
      socket.write(encodeJsonl({ type: "response", id: message.id, success: true, result }));
    });
    socket.on("data", (chunk) => reader.write(chunk));
  });
  return new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      done({
        accepted, requests, peerClosed,
        close: async () => {
          for (const socket of accepted) socket.destroy();
          await new Promise<void>((done, reject) => { server.close((error) => error ? reject(error) : done()); });
        },
      });
    });
  });
}

function isolatedHost(): { root: string; agentDir: string; socket: string; directory: string } {
  const root = temporary();
  const agentDir = join(root, "agent");
  process.env.PI_AGENTS_NATIVE_DIR = join(root, "host");
  const paths = nativeDaemonPaths(agentDir);
  mkdirSync(paths.directory, { recursive: true });
  return { root, agentDir, socket: paths.socket, directory: paths.directory };
}

describe("frontend host connection", () => {
  it("rejects an oversized UTF-8 input record before putting it on the socket", async () => {
    const host = isolatedHost();
    const fake = await listenFakeHost(host.socket, "refuse");
    const connection = await connectNative(host.socket);
    try {
      const error = once(connection.socket, "error");
      connection.send({ type: "input", data: "☃".repeat(350000) });
      await expect(error).resolves.toEqual([expect.objectContaining({ message: expect.stringMatching(/limit|bound|large/i) })]);
      expect(connection.socket.destroyed).toBe(true);
      expect(fake.requests).toEqual([]);
    } finally { connection.socket.destroy(); await fake.close(); }
  });

  it("keeps the live connection usable when the host explicitly refuses the automatic stop", async () => {
    const host = isolatedHost();
    const fake = await listenFakeHost(host.socket, "refuse");
    let connection: Awaited<ReturnType<typeof ensureNativeConnection>> | undefined;
    try {
      connection = await ensureNativeConnection(host.root, true, host.agentDir);

      expect(connection.socket.destroyed).toBe(false);
      expect(connection.hostNotice).toContain("0.0.9");
      expect(connection.hostNotice).toContain("the host refused the automatic stop");
      expect(connection.hostNotice).toContain("/agents restart");

      // The refusal is an answer, not a dead transport: the same connection still serves
      // requests and no second host connection was opened.
      const status = await connection.request("status") as { version?: string; sessions?: unknown[] };
      expect(status).toMatchObject({ version: "0.0.9" });
      expect(Array.isArray(status.sessions)).toBe(true);
      expect(fake.accepted).toHaveLength(1);

      const stops = fake.requests.filter((message) => message.type === "stop");
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatchObject({ onlyIfSettled: true });
      // The refused update must not fall through to starting a replacement host.
      expect(existsSync(join(host.directory, "host.log"))).toBe(false);
    } finally {
      connection?.socket.destroy();
      await fake.close();
    }
  });

  it("reports a lost host connection during the automatic stop as a failure", async () => {
    const host = isolatedHost();
    const fake = await listenFakeHost(host.socket, "drop");
    try {
      await expect(ensureNativeConnection(host.root, true, host.agentDir))
        .rejects.toThrow(/automatic update could not complete \(Native host connection closed\)/);

      // The unusable connection was cleaned up: the host saw its peer close.
      await expect(fake.peerClosed).resolves.toBe(fake.accepted[0]);
      expect(fake.requests.some((message) => message.type === "stop")).toBe(true);
      expect(existsSync(join(host.directory, "host.log"))).toBe(false);
    } finally {
      await fake.close();
    }
  });
});
