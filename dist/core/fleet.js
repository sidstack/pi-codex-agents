/** Only a record with a live view and no disposal in progress may own the terminal. */
export function isNavigable(record) {
    return !!record?.view && !record.stopping && record.activity !== "inactive" && record.activity !== "stopped";
}
/** Navigation changes terminal ownership only; it never touches agent execution. */
export class NativeFleet {
    sessions = new Map();
    activeId = "home";
    foregroundVisible = true;
    queue = Promise.resolve();
    onChange = () => { };
    handoffIds = new Set();
    isChangingTerminal(id) { return this.handoffIds.has(id); }
    waitForNavigation() { return this.queue; }
    navigationAllowed() { return true; }
    activate(id) {
        const task = this.queue.then(() => this.handoff(id));
        this.queue = task.catch(() => { });
        return task;
    }
    async handoff(id) {
        if (!this.navigationAllowed())
            throw new Error("The session host is closing");
        if (id === this.activeId)
            return;
        const next = this.sessions.get(id);
        const previous = this.sessions.get(this.activeId);
        // Reject before changing terminal ownership. An inactive or unloading record still has
        // its view here, but disposal can clear it at any moment and leave the foreground
        // session without a view, which permanently breaks navigation.
        if (!isNavigable(next))
            throw new Error(`Session unavailable: ${id}`);
        if (!previous?.view)
            throw new Error("Current native view has not been captured");
        if (previous.activity === "inactive" || previous.activity === "stopped")
            throw new Error(`Current native view is unloading: ${previous.id}`);
        this.handoffIds.add(previous.id);
        this.handoffIds.add(next.id);
        const nextView = next.view;
        previous.lastActivityAt = Date.now();
        previous.view.lease.pauseProgress();
        previous.view.ui.stop();
        previous.view.lease.enabled = false;
        this.activeId = id;
        nextView.lease.enabled = true;
        try {
            await nextView.start();
            nextView.lease.restore();
            nextView.ui.requestRender(true);
            next.unread = false;
            next.lastActivityAt = Date.now();
        }
        catch (error) {
            // Restore a usable terminal even if native initialization failed halfway.
            nextView.ui.stop();
            nextView.lease.enabled = false;
            this.fail(next, error);
            this.activeId = previous.id;
            previous.view.lease.enabled = true;
            await previous.view.start();
            previous.view.lease.restore();
            previous.view.ui.requestRender(true);
            throw error;
        }
        finally {
            this.handoffIds.delete(previous.id);
            this.handoffIds.delete(next.id);
            this.onChange();
        }
    }
    fail(record, error) {
        record.activity = "failed";
        record.lastError = error instanceof Error ? error.message : String(error);
        record.unread ||= !this.foregroundVisible || record.id !== this.activeId;
        this.onChange();
    }
    event(record, type) {
        record.lastActivityAt = Date.now();
        if (type === "start") {
            record.running = true;
            record.lastError = undefined;
        }
        if (type === "settled")
            record.running = false;
        if (type === "prompt-start")
            record.prompts++;
        if (type === "prompt-end")
            record.prompts = Math.max(0, record.prompts - 1);
        if (record.activity !== "stopped") {
            record.activity = record.lastError ? "failed" : record.prompts ? "waiting" : record.running ? "running" : "ready";
        }
        record.unread ||= !this.foregroundVisible || record.id !== this.activeId;
        this.onChange();
    }
}
//# sourceMappingURL=fleet.js.map