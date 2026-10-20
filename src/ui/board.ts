import { homedir } from "node:os";
import { basename } from "node:path";
import { Input, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { plainText } from "../core/security.js";
import type { Activity, LiveSession, NativeFleet } from "../core/fleet.js";

export type BoardAction = { kind: "switch" | "abort" | "stop"; id: string } | { kind: "new" | "pick" | "exit" | "leave" };
/** Active is every session the host can still run in; Inactive is unloaded history. */
const FILTERS = ["Active", "Inactive", "All"] as const;
const ACTIVE = new Set<Activity>(["ready", "running", "waiting", "failed"]);
const STATUS = { ready: "Ready", running: "Running", waiting: "Needs Input", failed: "Failed", inactive: "Inactive", stopped: "Stopped" } as const;
const COLOR = { ready: "success", running: "accent", waiting: "warning", failed: "error", inactive: "muted", stopped: "muted" } as const;

export function commandCenterSize(columns: number, rows: number, fullscreen = false): { width: number; height: number } {
  if (fullscreen) return { width: Math.max(1, columns), height: Math.max(1, rows) };
  return {
    width: Math.max(1, Math.min(columns - 2, Math.floor(columns * 0.94))),
    height: Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.88))),
  };
}

/** Home-relative display for paths, shared by the board and the directory picker. */
export function abbreviatePath(cwd: string): string {
  return cwd === homedir() ? "~" : cwd.startsWith(`${homedir()}/`) ? `~${cwd.slice(homedir().length)}` : cwd;
}

/** A spacious dashboard in a native overlay, sized from the physical terminal. */
export class CommandCenter implements Component {
  private readonly search = new Input({ prompt: "Search  ", placeholder: "Find a session or project…" });
  private selected = 0;
  private filter = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly fleet: NativeFleet,
    private readonly theme: Theme,
    private readonly redraw: () => void,
    private readonly done: (action: BoardAction | undefined) => void,
    private readonly terminalRows: () => number = () => 40,
    private readonly fullscreen = false,
  ) {
    this.selected = Math.max(0, this.rows().findIndex((row) => row.id === fleet.activeId));
    this.timer = setInterval(redraw, 250);
  }

  private matches(row: LiveSession, filter: number): boolean {
    if (filter === 2) return true;
    const settled = !ACTIVE.has(row.activity);
    return filter === 1 ? settled : !settled;
  }

  private rows(): LiveSession[] {
    const query = this.search.getValue().toLowerCase();
    return [...this.fleet.sessions.values()]
      .filter((r) => this.matches(r, this.filter) && `${r.name} ${r.cwd} ${r.activity}`.toLowerCase().includes(query))
      .sort((a, b) => a.cwd.localeCompare(b.cwd));
  }

  handleInput(data: string): void {
    const rows = this.rows();
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+g")) return this.done(undefined);
    if (matchesKey(data, "ctrl+n")) return this.done({ kind: "new" });
    // Ctrl+Shift+N is accepted when the terminal distinguishes it; Ctrl+P is the
    // portable chord, because legacy terminals report Ctrl+Shift+letter as Ctrl+letter.
    if (matchesKey(data, "ctrl+shift+n") || matchesKey(data, "ctrl+p")) return this.done({ kind: "pick" });
    if (matchesKey(data, "ctrl+q")) return this.done({ kind: "exit" });
    // The overlay owns input, so Pi's own suspend key has to be routed here.
    if (matchesKey(data, "ctrl+z")) return this.done({ kind: "leave" });
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.filter = (this.filter + (matchesKey(data, "shift+tab") ? FILTERS.length - 1 : 1)) % FILTERS.length;
      this.selected = 0;
    } else if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down")) this.selected = Math.min(rows.length - 1, this.selected + 1);
    else {
      const row = rows[this.selected];
      if (row && matchesKey(data, "enter")) return this.done({ kind: "switch", id: row.id });
      if (row && matchesKey(data, "ctrl+x")) return this.done({ kind: "abort", id: row.id });
      if (row && matchesKey(data, "ctrl+k")) return this.done({ kind: "stop", id: row.id });
      const before = this.search.getValue();
      this.search.handleInput(data);
      if (before !== this.search.getValue()) this.selected = 0;
    }
    this.redraw();
  }

  render(width: number): string[] {
    const height = commandCenterSize(width, this.terminalRows(), this.fullscreen).height;
    const chrome = this.fullscreen ? 0 : 2;
    const fg = this.theme.fg.bind(this.theme);
    const inner = Math.max(1, width - (this.fullscreen ? 2 : 6));
    const pad = (text: string, size = inner) => {
      const clipped = truncateToWidth(text, size);
      return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped)));
    };
    const pair = (left: string, right: string) => pad(left, Math.max(1, inner - visibleWidth(right) - 2)) + "  " + right;
    const path = abbreviatePath;
    const all = [...this.fleet.sessions.values()];
    // Unnamed sessions are labelled by their project directory. Only duplicates in the
    // same directory need a number, and it is assigned in fleet order so the label
    // does not change when a filter or search hides rows.
    const perDirectory = new Map<string, number>();
    for (const row of all) perDirectory.set(row.cwd, (perDirectory.get(row.cwd) ?? 0) + 1);
    const labels = new Map<string, string>();
    const numbered = new Map<string, number>();
    for (const row of all) {
      const base = plainText(row.name);
      if (row.name !== basename(row.cwd) || (perDirectory.get(row.cwd) ?? 1) < 2) { labels.set(row.id, base); continue; }
      const index = (numbered.get(row.cwd) ?? 0) + 1;
      numbered.set(row.cwd, index);
      labels.set(row.id, `${base} ${index}`);
    }
    const title = (row: LiveSession) => labels.get(row.id) ?? plainText(row.name);
    const rows = this.rows();
    this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
    const selected = rows[this.selected];
    const compact = height < 20;
    const lines: string[] = [
      pair(this.theme.bold("Agent command center"), fg("muted", `${all.filter((r) => this.matches(r, 0)).length} active · ${all.filter((r) => this.matches(r, 1)).length} inactive`)),
      ...(!compact ? [fg("muted", "Your projects and live sessions"), ""] : []),
      FILTERS.map((label, index) => {
        const text = ` ${label} ${all.filter((r) => this.matches(r, index)).length} `;
        return this.filter === index ? this.theme.bg("selectedBg", this.theme.bold(fg("accent", text))) : fg("muted", text);
      }).join("  "),
      ...(!compact ? [""] : []),
      ...this.search.render(inner),
      fg("borderMuted", "─".repeat(inner)),
    ];
    const footer = [
      fg("dim", `${rows.length ? this.selected + 1 : 0} / ${rows.length} sessions · ↑/↓ select`),
      fg("borderMuted", "─".repeat(inner)),
      ...(!compact ? [
        selected ? pair(this.theme.bold(title(selected)), fg(COLOR[selected.activity], STATUS[selected.activity])) : "",
        selected ? fg(selected.lastError ? "error" : "muted", plainText(selected.lastError || path(selected.cwd))) : "",
      ] : []),
      fg("muted", inner >= 72 ? "↑/↓ select   Enter open   Ctrl+N new here   Ctrl+P new in another directory   Tab filter" : "Enter open · Ctrl+N new here · Ctrl+P new elsewhere · Tab filter"),
      fg("dim", inner >= 72 ? "Ctrl+X abort run   Ctrl+K stop   Ctrl+Z back to Pi   Ctrl+Q quit Pi" : "Ctrl+X abort · Ctrl+K stop · Ctrl+Q quit"),
    ];
    const budget = Math.max(1, height - chrome - 2 - lines.length - footer.length);
    // Count project headers as real rows, so selection is reachable on short terminals.
    const entries: { id?: string; text: string; selected?: boolean }[] = [];
    let project: string | undefined;
    for (const row of rows) {
      if (row.cwd !== project) {
        entries.push({ text: this.theme.bold(fg("muted", path(row.cwd))) });
        project = row.cwd;
      }
      const current = row.id === this.fleet.activeId;
      const marker = row.activity === "running" ? "◉" : row.activity === "waiting" || row.activity === "failed" ? "!" : "○";
      const label = `${row.id === selected?.id ? "›" : " "} ${fg(COLOR[row.activity], marker)}  ${title(row)}`;
      const meta = `${current ? "  current" : row.unread ? "  new activity" : ""}`;
      entries.push({ id: row.id, selected: row.id === selected?.id,
        text: pair(label, `${fg("muted", meta)}  ${fg(COLOR[row.activity], STATUS[row.activity])}`) });
    }
    const position = entries.findIndex((entry) => entry.id === selected?.id);
    const offset = Math.max(0, Math.min(position - budget + 1, entries.length - budget));
    const visible = entries.slice(offset, offset + budget);
    for (const entry of visible) {
      const line = pad(entry.text);
      lines.push(entry.selected ? this.theme.bg("selectedBg", line) : line);
    }
    if (!entries.length) lines.push(fg("muted", "No matching sessions. Ctrl+N starts one here, Ctrl+P in another directory."));
    while (lines.length < height - chrome - 2 - footer.length) lines.push("");
    lines.push(...footer);
    const body = lines.slice(0, Math.max(0, height - chrome));
    while (body.length < height - chrome) body.push("");
    if (width < 8 || height < 5) return body.map((line) => truncateToWidth(line, width));
    // Full screen fills the terminal edge to edge; the framed board leaves room for its box.
    if (this.fullscreen) return body.map((line) => pad(line, width));
    const edge = fg("border", "│");
    return [
      fg("border", `╭${"─".repeat(width - 2)}╮`),
      ...body.map((line) => `${edge}  ${pad(line)}  ${edge}`),
      fg("border", `╰${"─".repeat(width - 2)}╯`),
    ];
  }

  invalidate(): void { this.search.invalidate(); }
  dispose(): void { clearInterval(this.timer); }
}
