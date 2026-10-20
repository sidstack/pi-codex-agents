import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CommandCenter, commandCenterSize } from "../src/ui/board.js";
import { NativeFleet } from "../src/core/fleet.js";

const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function fleet(count = 3): NativeFleet {
  const state = new NativeFleet();
  for (let i = 0; i < count; i++) {
    const id = i === 0 ? "home" : `session-${i}`;
    state.sessions.set(id, { id, name: `Task ${i}`, cwd: `/project/${String(Math.floor(i / 3)).padStart(2, "0")}`,
      activity: i === 1 ? "running" : "ready", running: i === 1, prompts: 0, unread: false });
  }
  return state;
}

describe("native command center layout", () => {
  it("fills its panel at different terminal sizes and keeps the footer on resize", () => {
    let rows = 40;
    const board = new CommandCenter(fleet(), theme, () => {}, () => {}, () => rows);
    try {
      for (const size of [{ columns: 120, rows: 40 }, { columns: 80, rows: 24 }, { columns: 50, rows: 16 }]) {
        rows = size.rows;
        const dimensions = commandCenterSize(size.columns, rows);
        const lines = board.render(dimensions.width);
        expect(lines).toHaveLength(dimensions.height);
        expect(lines.every((line) => visibleWidth(line) === dimensions.width)).toBe(true);
        expect(lines.join("\n")).toContain("Enter open");
        expect(lines[0]).toMatch(/^╭─/);
        expect(lines.at(-1)).toMatch(/─╯$/);
      }
    } finally { board.dispose(); }
  });

  it("fills the whole terminal in full-screen mode and routes Ctrl+Q and Ctrl+Z", () => {
    const done = vi.fn();
    const board = new CommandCenter(fleet(), theme, () => {}, done, () => 40, true);
    try {
      expect(commandCenterSize(120, 40, true)).toEqual({ width: 120, height: 40 });
      const lines = board.render(120);
      expect(lines).toHaveLength(40);
      expect(lines.every((line) => visibleWidth(line) === 120)).toBe(true);
      const text = lines.join("\n");
      expect(text).not.toContain("╭");
      expect(text).toContain("Ctrl+Q quit Pi");
      expect(text).toContain("Ctrl+Z back to Pi");
      board.handleInput("\x11");
      expect(done).toHaveBeenLastCalledWith({ kind: "exit" });
      board.handleInput("\x1a");
      expect(done).toHaveBeenLastCalledWith({ kind: "leave" });
    } finally { board.dispose(); }
  });

  it("keeps the selected session visible through a long list on a short terminal", () => {
    const done = vi.fn();
    const board = new CommandCenter(fleet(60), theme, () => {}, done, () => 16);
    try {
      for (let i = 0; i < 59; i++) board.handleInput("\x1b[B");
      const lines = board.render(70).join("\n");
      expect(lines).toContain("Task 59");
      board.handleInput("\r");
      expect(done).toHaveBeenCalledWith({ kind: "switch", id: "session-59" });
    } finally { board.dispose(); }
  });

  it("labels unnamed sessions by project directory and numbers only duplicates", () => {
    const state = new NativeFleet();
    for (const [id, cwd] of [["a", "/srv/api"], ["b", "/srv/api"], ["c", "/srv/web"]] as const) {
      state.sessions.set(id, { id, name: cwd.split("/").pop()!, cwd, activity: "ready", running: false, prompts: 0, unread: false });
    }
    const board = new CommandCenter(state, theme, () => {}, vi.fn(), () => 40);
    try {
      const lines = board.render(70).join("\n");
      expect(lines).toContain("api 1");
      expect(lines).toContain("api 2");
      expect(lines).toContain("web");
      expect(lines).not.toContain("Runner");
    } finally { board.dispose(); }
  });

  it("opens on Active, which covers ready, running, and needs-input sessions", () => {
    const state = fleet();
    const waiting = state.sessions.get("session-1")!;
    waiting.activity = "waiting";
    waiting.prompts = 1;
    state.sessions.set("saved:infra", { id: "saved:infra", name: "Saved infra", cwd: "/project/01",
      activity: "inactive", running: false, prompts: 0, unread: false });
    state.activeId = "session-2";
    const done = vi.fn();
    const board = new CommandCenter(state, theme, () => {}, done);
    try {
      const chips = board.render(70).join("\n");
      expect(chips).toContain("Active");
      expect(chips).toContain("Inactive");
      expect(chips).toContain("All");
      expect(chips).toContain("Needs Input");
      expect(chips).toContain("Task 1");
      expect(chips).not.toContain("Saved infra");

      board.handleInput("\r");
      expect(done).toHaveBeenLastCalledWith({ kind: "switch", id: "session-2" });

      board.handleInput("\t");
      const settled = board.render(70).join("\n");
      expect(settled).toContain("Saved infra");
      expect(settled).not.toContain("Task 1");
      board.handleInput("\r");
      expect(done).toHaveBeenLastCalledWith({ kind: "switch", id: "saved:infra" });

      board.handleInput("\t");
      expect(board.render(70).join("\n")).toContain("Saved infra");
      board.handleInput("\t");
      expect(board.render(70).join("\n")).not.toContain("Saved infra");
    } finally { board.dispose(); }
  });

  it("routes Ctrl+N to a session here and Ctrl+P to a directory choice", () => {
    const done = vi.fn();
    const board = new CommandCenter(fleet(), theme, () => {}, done, () => 40, true);
    try {
      const text = board.render(120).join("\n");
      expect(text).toContain("Ctrl+N new here");
      expect(text).toContain("Ctrl+P new in another directory");
      board.handleInput("\x0e");
      expect(done).toHaveBeenLastCalledWith({ kind: "new" });
      board.handleInput("\x10");
      expect(done).toHaveBeenLastCalledWith({ kind: "pick" });
    } finally { board.dispose(); }
  });
});
