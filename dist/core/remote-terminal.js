/** A structured Terminal transport, not a PTY or transcript scraper. */
export class TerminalHub {
    columns = 100;
    rows = 30;
    kittyProtocolActive = false;
    active;
    send = () => { };
    dimensions(columns, rows, kitty) {
        this.columns = Math.max(10, Math.min(1000, Math.floor(columns)));
        this.rows = Math.max(5, Math.min(500, Math.floor(rows)));
        this.kittyProtocolActive = kitty;
        this.active?.resize?.();
    }
}
export class RemoteTerminal {
    hub;
    input;
    resize;
    constructor(hub) {
        this.hub = hub;
    }
    get columns() { return this.hub.columns; }
    get rows() { return this.hub.rows; }
    get kittyProtocolActive() { return this.hub.kittyProtocolActive; }
    start(input, resize) {
        this.input = input;
        this.resize = resize;
        this.hub.active = this;
    }
    stop() { if (this.hub.active === this)
        this.hub.active = undefined; }
    async drainInput() { }
    call(method, ...args) { this.hub.send({ type: "terminal", method, args }); }
    write(data) { this.call("write", data); }
    moveBy(lines) { this.call("moveBy", lines); }
    hideCursor() { this.call("hideCursor"); }
    showCursor() { this.call("showCursor"); }
    clearLine() { this.call("clearLine"); }
    clearFromCursor() { this.call("clearFromCursor"); }
    clearScreen() { this.call("clearScreen"); }
    setTitle(title) { this.call("setTitle", title); }
    setProgress(active) { this.call("setProgress", active); }
    setProgramStatus(status) { this.call("setProgramStatus", status); }
}
//# sourceMappingURL=remote-terminal.js.map