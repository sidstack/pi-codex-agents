import { homedir } from "node:os";
import { opendir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Input, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { plainText } from "../core/security.js";
import { abbreviatePath, commandCenterSize } from "./board.js";

export interface PickerProject { cwd: string; name: string; activity: string; lastActivityAt: number }
export interface PickerCandidate { path: string; source: "here" | "typed" | "project" | "directory"; existing: boolean }

const LIST_LIMIT = 200;
const PROJECT_LIMIT = 12;
const CANDIDATE_LIMIT = 40;
const CACHE_TTL_MS = 2000;
const CACHE_LIMIT = 64;
const DEBOUNCE_MS = 60;
const listings = new Map<string, { at: number; entries: string[]; truncated: boolean }>();

/** `~`, `~/x` and relative paths resolve against the session the picker was opened from. */
export function expandDirectory(text: string, base: string): string {
  const trimmed = text.trim();
  return resolve(base, trimmed.replace(/^~(?=\/|$)/, homedir()) || base);
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/** Bounded completion listing. An unreadable directory completes nothing, never an error. */
export async function listSubdirectories(directory: string, limit = LIST_LIMIT): Promise<{ entries: string[]; truncated: boolean }> {
  const key = resolve(directory);
  const cached = listings.get(key);
  const listing = cached && Date.now() - cached.at < CACHE_TTL_MS ? cached : await scanDirectories(key);
  const size = Math.min(Math.max(1, limit), LIST_LIMIT);
  return { entries: listing.entries.slice(0, size), truncated: listing.truncated || listing.entries.length > size };
}

async function scanDirectories(key: string): Promise<{ at: number; entries: string[]; truncated: boolean }> {
  const entries: string[] = [];
  let truncated = false;
  try {
    for await (const entry of await opendir(key)) {
      if (!entry.isDirectory()) continue;
      if (entries.length >= LIST_LIMIT) { truncated = true; break; }
      entries.push(entry.name);
    }
  } catch { entries.length = 0; }
  entries.sort((a, b) => a.localeCompare(b));
  const result = { at: Date.now(), entries, truncated };
  if (listings.size >= CACHE_LIMIT) listings.delete(listings.keys().next().value ?? key);
  listings.set(key, result);
  return result;
}

/** Substring first, then a subsequence match, so short fragments still find a project. */
export function matchesQuery(query: string, path: string): boolean {
  if (!query) return true;
  const target = path.toLowerCase();
  if (target.includes(query)) return true;
  let index = 0;
  for (const character of query) {
    index = target.indexOf(character, index);
    if (index < 0) return false;
    index++;
  }
  return true;
}

/** Directory choice for a new session: recent projects, typed paths, and filesystem completion. */
export class PathPicker implements Component {
  private readonly input = new Input({ prompt: "Directory  ", placeholder: "~/project, a path, or a name…" });
  private candidates: PickerCandidate[] = [];
  private selected = 0;
  private truncated = false;
  private searching = false;
  private token = 0;
  private typed = "";
  private finished = false;
  private pending: Promise<void>;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly projects: readonly PickerProject[],
    private readonly cwd: string,
    private readonly theme: Theme,
    private readonly redraw: () => void,
    private readonly done: (path: string | undefined) => void,
    private readonly terminalRows: () => number = () => 40,
    private readonly fullscreen = false,
  ) {
    this.pending = this.refresh();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.pending = this.refresh(); }, DEBOUNCE_MS);
  }

  private async refresh(): Promise<void> {
    const token = ++this.token;
    const typed = this.input.getValue().trim();
    const query = typed.toLowerCase();
    const known = new Map<string, PickerProject>();
    for (const project of this.projects) if (!known.has(project.cwd)) known.set(project.cwd, project);
    const recent = [...known.values()]
      .filter((project) => matchesQuery(query, project.cwd) || matchesQuery(query, project.name))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, PROJECT_LIMIT);
    const candidates: PickerCandidate[] = [];
    const push = (path: string, source: PickerCandidate["source"]): void => {
      const key = resolve(path);
      if (candidates.some((candidate) => candidate.path === key)) return;
      candidates.push({ path: key, source, existing: known.has(key) });
    };
    this.searching = true;
    let truncated = false;
    if (!typed) {
      push(this.cwd, "here");
      for (const project of recent) push(project.cwd, "project");
      const listing = await listSubdirectories(this.cwd);
      truncated = listing.truncated;
      for (const name of listing.entries) if (!name.startsWith(".")) push(join(this.cwd, name), "directory");
    } else {
      const target = expandDirectory(typed, this.cwd);
      const completeInside = /[/\\]$/.test(typed);
      const parent = completeInside ? target : dirname(target);
      const fragment = completeInside ? "" : basename(target);
      const fragmentQuery = fragment.toLowerCase();
      if (await isDirectory(target)) push(target, "typed");
      const listing = await listSubdirectories(parent);
      truncated = listing.truncated;
      for (const name of listing.entries) {
        const lower = name.toLowerCase();
        if (fragment && !lower.startsWith(fragment) && !matchesQuery(fragmentQuery, name)) continue;
        if (!fragment && name.startsWith(".")) continue;
        push(join(parent, name), "directory");
      }
      for (const project of recent) push(project.cwd, "project");
    }
    if (token !== this.token) return; // a newer keystroke superseded this listing
    if (typed !== this.typed) this.selected = 0;
    this.typed = typed;
    this.truncated = truncated;
    this.searching = false;
    this.candidates = candidates.slice(0, CANDIDATE_LIMIT);
    this.selected = Math.max(0, Math.min(this.selected, this.candidates.length - 1));
    this.redraw();
  }

  private accept(): void {
    if (this.finished) return;
    // Enter never chooses from a listing that is still being computed or has not started.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.pending = this.refresh();
    }
    void Promise.resolve(this.pending).catch(() => {}).then(() => this.choose());
  }

  private choose(): void {
    if (this.finished) return;
    this.finished = true;
    const candidate = this.candidates[this.selected];
    if (candidate) return this.done(candidate.path);
    const typed = this.input.getValue().trim();
    this.done(typed ? expandDirectory(typed, this.cwd) : undefined);
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, "escape")) {
      this.finished = true;
      return this.done(undefined);
    }
    if (matchesKey(data, "enter")) return this.accept();
    if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down")) this.selected = Math.min(Math.max(0, this.candidates.length - 1), this.selected + 1);
    else if (matchesKey(data, "tab")) {
      const candidate = this.candidates[this.selected];
      if (candidate) {
        this.input.setValue(candidate.path === this.cwd ? "." : abbreviatePath(candidate.path));
        this.selected = 0;
        this.schedule();
      }
    } else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      if (before !== this.input.getValue()) {
        this.selected = 0;
        this.schedule();
      }
    }
    this.redraw();
  }

  render(width: number): string[] {
    const height = commandCenterSize(width, this.terminalRows(), this.fullscreen).height;
    const chrome = this.fullscreen ? 0 : 2;
    const inner = Math.max(1, width - (this.fullscreen ? 2 : 6));
    const fg = this.theme.fg.bind(this.theme);
    const pad = (text: string, size = inner) => {
      const clipped = truncateToWidth(text, size);
      return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped)));
    };
    const pair = (left: string, right: string) => pad(left, Math.max(1, inner - visibleWidth(right) - 2)) + "  " + right;
    const SOURCE = { here: "this directory", typed: "typed path", project: "session", directory: "directory" } as const;
    const lines: string[] = [
      pair(this.theme.bold("New native session"), fg("muted", `${this.candidates.length} directories`)),
      ...this.input.render(inner),
      fg("borderMuted", "─".repeat(inner)),
    ];
    const footer = [
      fg("dim", `${this.candidates.length ? this.selected + 1 : 0} / ${this.candidates.length} · ↑/↓ select`),
      fg("borderMuted", "─".repeat(inner)),
      fg("muted", inner >= 72 ? "Enter choose   Tab complete   Esc cancel" : "Enter choose · Tab complete · Esc cancel"),
    ];
    const budget = Math.max(1, height - chrome - 2 - lines.length - footer.length);
    const entries = this.candidates.map((candidate, index) => {
      const meta = `${candidate.existing ? "existing · " : ""}${SOURCE[candidate.source]}`;
      const text = pair(`${index === this.selected ? "›" : " "} ${plainText(abbreviatePath(candidate.path))}`, `${fg("muted", meta)}`);
      return index === this.selected ? this.theme.bg("selectedBg", text) : text;
    });
    const offset = Math.max(0, Math.min(this.selected - budget + 1, entries.length - budget));
    for (const entry of entries.slice(offset, offset + budget)) lines.push(pad(entry));
    if (!entries.length) lines.push(fg("muted", this.searching ? "Searching…" : "No matching directory. Type a path and press Enter."));
    if (this.truncated) lines.push(fg("muted", `Listing is limited to ${LIST_LIMIT} entries. Type to narrow it.`));
    while (lines.length < height - chrome - 2 - footer.length) lines.push("");
    lines.push(...footer);
    const body = lines.slice(0, Math.max(0, height - chrome));
    while (body.length < height - chrome) body.push("");
    if (width < 8 || height < 5) return body.map((line) => truncateToWidth(line, width));
    if (this.fullscreen) return body.map((line) => pad(line, width));
    const edge = fg("border", "│");
    return [
      fg("border", `╭${"─".repeat(width - 2)}╮`),
      ...body.map((line) => `${edge}  ${pad(line)}  ${edge}`),
      fg("border", `╰${"─".repeat(width - 2)}╯`),
    ];
  }

  invalidate(): void { this.input.invalidate(); }
  dispose(): void { clearTimeout(this.timer); }
}
