import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import { NativeSessionHost, type Session } from "../src/core/sessions.js";
import { TerminalLease } from "../src/core/terminal.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agentRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-launch-session-"));
  roots.push(root);
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  return root;
}

function withView(host: NativeSessionHost, id: string, cwd: string, lastActivityAt: number, sessionFile?: string): Session {
  const lease = new TerminalLease({ write: vi.fn(), start: vi.fn(), stop: vi.fn(), setProgress: vi.fn(), columns: 80 } as unknown as Terminal);
  const record: Session = {
    id, cwd, name: id, activity: "ready", running: false, prompts: 0, unread: false, lastActivityAt, sessionFile,
    view: { ui: { terminal: lease.terminal, stop: vi.fn(), requestRender: vi.fn() } as unknown as TUI, lease, start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) },
  };
  host.sessions.set(id, record);
  return record;
}

function stubRecord(id: string, cwd: string): Session {
  return { id, cwd, name: id, activity: "ready", running: false, prompts: 0, unread: false };
}

describe("the session a directory launches into", () => {
  it("reuses the live session for that directory instead of creating another one", async () => {
    const host = new NativeSessionHost(agentRoot(), () => ({} as Terminal));
    withView(host, "home", "/tmp/other", 100);
    const older = withView(host, "older", "/tmp/project", 200);
    const recent = withView(host, "recent", "/tmp/project", 900);
    const create = vi.spyOn(host, "create");

    await expect(host.ensureSessionForCwd("/tmp/project", () => true)).resolves.toBe("recent");
    expect(create).not.toHaveBeenCalled();
    expect(older.view).toBeDefined();
    expect(recent.view).toBeDefined();
  });

  it("resumes a saved session for that directory in place, keeping its id and history", async () => {
    const agentDir = agentRoot();
    const sessionFile = join(agentDir, "sessions", "--tmp-project--", "session.jsonl");
    mkdirSync(join(agentDir, "sessions", "--tmp-project--"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(sessionFile, '{"type":"session","cwd":"/tmp/project"}\n');
    const host = new NativeSessionHost(agentDir, () => ({} as Terminal));
    withView(host, "home", "/tmp/other", 100);
    host.sessions.set("saved", { id: "saved", cwd: "/tmp/project", name: "Project", activity: "inactive", running: false, prompts: 0, unread: false, lastActivityAt: 500, sessionFile, draft: "kept draft" });
    const create = vi.spyOn(host, "create").mockResolvedValue(stubRecord("saved", "/tmp/project"));

    await expect(host.ensureSessionForCwd("/tmp/project", () => true)).resolves.toBe("saved");
    expect(create).toHaveBeenCalledWith("/tmp/project", true, undefined, { id: "saved", name: "Project", sessionFile, sourceFile: undefined, draft: "kept draft" });
  });

  it("creates one new session when the directory has never been opened", async () => {
    const host = new NativeSessionHost(agentRoot(), () => ({} as Terminal));
    withView(host, "home", "/tmp/other", 100);
    const create = vi.spyOn(host, "create").mockResolvedValue(stubRecord("fresh", "/tmp/brand-new"));

    await expect(host.ensureSessionForCwd("/tmp/brand-new", () => true)).resolves.toBe("fresh");
    expect(create).toHaveBeenCalledWith("/tmp/brand-new", true);
  });

  it("trusts the directory through the caller's policy, not by assumption", async () => {
    const host = new NativeSessionHost(agentRoot(), () => ({} as Terminal));
    const create = vi.spyOn(host, "create").mockResolvedValue(stubRecord("fresh", "/tmp/untrusted"));

    await host.ensureSessionForCwd("/tmp/untrusted", () => false);
    expect(create).toHaveBeenCalledWith("/tmp/untrusted", false);
  });

  it("marks an unreachable managed history failed and starts a usable session", async () => {
    const agentDir = agentRoot();
    const host = new NativeSessionHost(agentDir, () => ({} as Terminal));
    host.sessions.set("broken", { id: "broken", cwd: "/tmp/project", name: "Project", activity: "inactive", running: false, prompts: 0, unread: false, lastActivityAt: 500, sessionFile: join(agentDir, "sessions", "missing.jsonl") });
    const create = vi.spyOn(host, "create").mockResolvedValue(stubRecord("fresh", "/tmp/project"));

    await expect(host.ensureSessionForCwd("/tmp/project", () => true)).resolves.toBe("fresh");
    expect(host.sessions.get("broken")).toMatchObject({ activity: "failed" });
    expect(host.sessions.get("broken")?.lastError).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
