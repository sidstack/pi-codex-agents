import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";

export type TerminalCall = { type: "terminal"; method: string; args: unknown[] };

/** A structured Terminal transport, not a PTY or transcript scraper. */
export class TerminalHub {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  active?: RemoteTerminal;
  send: (message: TerminalCall) => void = () => {};

  dimensions(columns: number, rows: number, kitty: boolean): void {
    this.columns = Math.max(10, Math.min(1000, Math.floor(columns)));
    this.rows = Math.max(5, Math.min(500, Math.floor(rows)));
    this.kittyProtocolActive = kitty;
    this.active?.resize?.();
  }
}

export class RemoteTerminal implements Terminal {
  input?: (data: string) => void;
  resize?: () => void;
  constructor(private readonly hub: TerminalHub) {}
  get columns(): number { return this.hub.columns; }
  get rows(): number { return this.hub.rows; }
  get kittyProtocolActive(): boolean { return this.hub.kittyProtocolActive; }
  start(input: (data: string) => void, resize: () => void): void {
    this.input = input; this.resize = resize; this.hub.active = this;
  }
  stop(): void { if (this.hub.active === this) this.hub.active = undefined; }
  async drainInput(): Promise<void> {}
  private call(method: string, ...args: unknown[]): void { this.hub.send({ type: "terminal", method, args }); }
  write(data: string): void { this.call("write", data); }
  moveBy(lines: number): void { this.call("moveBy", lines); }
  hideCursor(): void { this.call("hideCursor"); }
  showCursor(): void { this.call("showCursor"); }
  clearLine(): void { this.call("clearLine"); }
  clearFromCursor(): void { this.call("clearFromCursor"); }
  clearScreen(): void { this.call("clearScreen"); }
  setTitle(title: string): void { this.call("setTitle", title); }
  setProgress(active: boolean): void { this.call("setProgress", active); }
  setProgramStatus(status: ProgramStatus): void { this.call("setProgramStatus", status); }
}
