import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import { NativeSessionHost, type Session } from "../src/core/sessions.js";
import { DEFAULT_CONFIG } from "../src/config.js";
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
  it("starts a new session even when live sessions already show that directory", async () => {
    const host = new NativeSessionHost(agentRoot(), () => ({} as Terminal));
    withView(host, "home", "/tmp/other", 100);
    const older = withView(host, "older", "/tmp/project", 200);
    const recent = withView(host, "recent", "/tmp/project", 900);
    const create = vi.spyOn(host, "create").mockImplementation(async (cwd) => {
      const created = stubRecord("fresh", cwd);
      host.sessions.set(created.id, created);
      return created;
    });

    const result = await host.launchSessionForCwd("/tmp/project", () => true);

    expect(result.id).toBe("fresh");
    expect(result.launchError).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith("/tmp/project", true);
    // The directory's existing sessions are still there and still usable.
    expect(older.view).toBeDefined();
    expect(recent.view).toBeDefined();
    // One new row beside them: the launch did not take over an existing session.
    expect(host.sessions.size).toBe(4);
    expect(host.sessions.get("recent")?.view).toBeDefined();
  });

  it("leaves a saved session for that directory, its history and its draft untouched", async () => {
    const agentDir = agentRoot();
    const sessionFile = join(agentDir, "sessions", "--tmp-project--", "session.jsonl");
    mkdirSync(join(agentDir, "sessions", "--tmp-project--"), { recursive: true });
    writeFileSync(sessionFile, '{"type":"session","cwd":"/tmp/project"}\n');
    const host = new NativeSessionHost(agentDir, () => ({} as Terminal));
    withView(host, "home", "/tmp/other", 100);
    host.sessions.set("saved", { id: "saved", cwd: "/tmp/project", name: "Project", activity: "inactive", running: false, prompts: 0, unread: false, lastActivityAt: 500, sessionFile, draft: "kept draft" });
    const create = vi.spyOn(host, "create").mockResolvedValue(stubRecord("fresh", "/tmp/project"));

    const result = await host.launchSessionForCwd("/tmp/project", () => true);

    expect(result.id).toBe("fresh");
    expect(result.launchError).toBeUndefined();
    // Nothing is resumed in place: the launch never reuses a saved id or history file.
    expect(create).toHaveBeenCalledWith("/tmp/project", true);
    expect(host.sessions.get("saved")).toMatchObject({ id: "saved", activity: "inactive", sessionFile, draft: "kept draft" });
    expect(host.sessions.get("saved")?.view).toBeUndefined();
  });

  it("claims the Home session this host created for the launch directory", async () => {
    const host = new NativeSessionHost(agentRoot(), () => ({} as Terminal));
    const home = withView(host, "home", "/tmp/project", 100);
    const create = vi.spyOn(host, "create");

    const result = await host.launchSessionForCwd("/tmp/project", () => true, "home");

    expect(result.id).toBe("home");
    expect(result.launchError).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(host.sessions.size).toBe(1);
    expect(home.cwd).toBe("/tmp/project");
  });

  it("does not claim a Home that belongs to another directory or is stopping", async () => {
    const host = new NativeSessionHost(agentRoot(), () => ({} as Terminal));
    withView(host, "home", "/tmp/other", 100);
    const create = vi.spyOn(host, "create").mockResolvedValue(stubRecord("fresh", "/tmp/project"));

    await expect(host.launchSessionForCwd("/tmp/project", () => true, "home")).resolves.toMatchObject({ id: "fresh" });
    expect(create).toHaveBeenCalledWith("/tmp/project", true);

    const stopping = new NativeSessionHost(agentRoot(), () => ({} as Terminal));
    const leaving = withView(stopping, "home", "/tmp/project", 100);
    leaving.stopping = true;
    const createSecond = vi.spyOn(stopping, "create").mockResolvedValue(stubRecord("fresh", "/tmp/project"));

    await expect(stopping.launchSessionForCwd("/tmp/project", () => true, "home")).resolves.toMatchObject({ id: "fresh" });
    expect(createSecond).toHaveBeenCalledTimes(1);
  });

  it("trusts the directory through the caller's policy, not by assumption", async () => {
    const host = new NativeSessionHost(agentRoot(), () => ({} as Terminal));
    const create = vi.spyOn(host, "create").mockResolvedValue(stubRecord("fresh", "/tmp/untrusted"));

    await host.launchSessionForCwd("/tmp/untrusted", () => false);
    expect(create).toHaveBeenCalledWith("/tmp/untrusted", false);
  });

  it("gives two launches in the same directory distinct sessions and distinct histories", async () => {
    const agentDir = agentRoot();
    const directory = join(agentDir, "sessions", "--tmp-project--");
    mkdirSync(directory, { recursive: true });
    const olderHistory = join(directory, "older.jsonl");
    writeFileSync(olderHistory, '{"type":"session","cwd":"/tmp/project"}\n');
    const host = new NativeSessionHost(agentDir, () => ({} as Terminal));
    host.sessions.set("saved", { id: "saved", cwd: "/tmp/project", name: "Project", activity: "inactive", running: false, prompts: 0, unread: false, lastActivityAt: 500, sessionFile: olderHistory, draft: "kept draft" });
    // Pi names each new managed history after its own session id, so every launch writes its own file.
    let launches = 0;
    vi.spyOn(host, "create").mockImplementation(async (cwd) => {
      launches += 1;
      const id = randomUUID();
      const sessionFile = join(directory, `launch-${launches}_${id}.jsonl`);
      writeFileSync(sessionFile, `${JSON.stringify({ type: "session", cwd })}\n`);
      const created: Session = { ...stubRecord(id, cwd), sessionFile };
      host.sessions.set(id, created);
      return created;
    });

    const first = await host.launchSessionForCwd("/tmp/project", () => true);
    const second = await host.launchSessionForCwd("/tmp/project", () => true);

    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toBe("saved");
    const firstRow = host.sessions.get(first.id)!;
    const secondRow = host.sessions.get(second.id)!;
    expect(firstRow.sessionFile).toBeTruthy();
    expect(secondRow.sessionFile).toBeTruthy();
    expect(firstRow.sessionFile).not.toBe(secondRow.sessionFile);
    expect(existsSync(firstRow.sessionFile!)).toBe(true);
    expect(existsSync(secondRow.sessionFile!)).toBe(true);
    // The older session keeps its row, its history file and its draft.
    expect(host.sessions.get("saved")).toMatchObject({ activity: "inactive", sessionFile: olderHistory, draft: "kept draft" });
    expect(existsSync(olderHistory)).toBe(true);
  });

  it("rejects when a new session cannot start, so the host keeps its previous foreground", async () => {
    const host = new NativeSessionHost(agentRoot(), () => ({} as Terminal));
    withView(host, "home", "/tmp/other", 100);
    vi.spyOn(host, "create").mockRejectedValue(new Error("Not a directory: /tmp/gone"));

    await expect(host.launchSessionForCwd("/tmp/gone", () => true)).rejects.toThrow("Not a directory: /tmp/gone");
    expect(host.sessions.get("home")?.view).toBeDefined();
  });
});

describe("a launch that reopens the directory's last session", () => {
  function resumeHost(agentDir: string): NativeSessionHost {
    return new NativeSessionHost(agentDir, () => ({} as Terminal), { ...DEFAULT_CONFIG, resumeLastSession: true });
  }

  it("reopens the most recently active live session instead of starting another", async () => {
    const host = resumeHost(agentRoot());
    withView(host, "home", "/tmp/other", 1000);
    withView(host, "older", "/tmp/project", 200);
    withView(host, "recent", "/tmp/project", 900);
    const create = vi.spyOn(host, "create");

    const result = await host.launchSessionForCwd("/tmp/project", () => true, "home");

    expect(result).toEqual({ id: "recent" });
    expect(create).not.toHaveBeenCalled();
    // No extra row: the launch took over the directory's last session.
    expect(host.sessions.size).toBe(3);
  });

  it("resumes the saved history and draft in place when no live session is open", async () => {
    const agentDir = agentRoot();
    const directory = join(agentDir, "sessions", "--tmp-project--");
    mkdirSync(directory, { recursive: true });
    const sessionFile = join(directory, "session.jsonl");
    writeFileSync(sessionFile, '{"type":"session","cwd":"/tmp/project"}\n');
    const host = resumeHost(agentDir);
    host.sessions.set("saved", { id: "saved", cwd: "/tmp/project", name: "Project", activity: "inactive", running: false, prompts: 0, unread: false, lastActivityAt: 500, sessionFile, draft: "kept draft" });
    const create = vi.spyOn(host, "create").mockResolvedValue(stubRecord("saved", "/tmp/project"));

    const result = await host.launchSessionForCwd("/tmp/project", () => true);

    expect(result).toEqual({ id: "saved" });
    // The same id, history file and draft come back: the launch resumed in place.
    expect(create).toHaveBeenCalledWith("/tmp/project", true, undefined, expect.objectContaining({ id: "saved", sessionFile, draft: "kept draft" }));
  });

  it("starts a usable session and marks the row failed when the saved history is unreachable", async () => {
    const agentDir = agentRoot();
    const host = resumeHost(agentDir);
    // Outside the managed sessions directory, so opening it is refused.
    host.sessions.set("saved", { id: "saved", cwd: "/tmp/project", name: "Project", activity: "inactive", running: false, prompts: 0, unread: false, lastActivityAt: 500, sessionFile: join(agentDir, "outside.jsonl") });
    const create = vi.spyOn(host, "create").mockResolvedValue(stubRecord("fresh", "/tmp/project"));

    const result = await host.launchSessionForCwd("/tmp/project", () => true);

    expect(result.id).toBe("fresh");
    expect(result.launchError).toMatch(/Could not resume saved session Project in \/tmp\/project/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(host.sessions.get("saved")?.activity).toBe("failed");
  });

  it("still starts a new session when the directory has none", async () => {
    const host = resumeHost(agentRoot());
    withView(host, "home", "/tmp/other", 100);
    const create = vi.spyOn(host, "create").mockResolvedValue(stubRecord("fresh", "/tmp/project"));

    const result = await host.launchSessionForCwd("/tmp/project", () => true, "home");

    expect(result).toEqual({ id: "fresh" });
    expect(create).toHaveBeenCalledWith("/tmp/project", true);
  });
});
