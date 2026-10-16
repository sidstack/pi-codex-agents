import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { commandCenterKey } from "./features/navigation.js";
import { statusParts } from "./features/status.js";
import { attachTerminal } from "./pi/attachment.js";
import { ensureNativeConnection, stopNativeHost } from "./pi/client.js";
import { VERSION, BUILD_ID } from "./version.js";
import { countUnsettled } from "./core/activity.js";
/** Pi is the only entry point. Managed native views live in the persistent host. */
export default function piAgents(pi) {
    // Managed sessions receive their own inline /agents extension. Loading the
    // installed package there must not register a second launcher recursively.
    if (process.env.PI_AGENTS_NATIVE_DAEMON === "1")
        return;
    let opening = false;
    let prompts = 0;
    let frontendConfig;
    let removeInput;
    // Only the first session of the frontend process may attach itself; a later /new,
    // resume, or /reload in ordinary Pi must leave that Pi alone.
    let launchAttached = false;
    let launchPending = false;
    let launchCtx;
    const openOnce = async (ctx, options) => {
        // Connect before stopping Pi so startup failures leave the editor usable.
        const connection = await ensureNativeConnection(ctx.cwd, true, getAgentDir(), { autoUpdateHost: frontendConfig?.autoUpdateHost !== false });
        let failure;
        let notice = "";
        let launchError = "";
        let quitFrontend = false;
        let restartHost = false;
        try {
            await ctx.ui.custom((tui, _theme, _keys, done) => {
                queueMicrotask(() => {
                    void (async () => {
                        tui.stop();
                        try {
                            const result = await attachTerminal(connection, tui.terminal, options);
                            notice = result.reason;
                            launchError = result.launchError ?? "";
                            quitFrontend = result.quitFrontend;
                            restartHost = result.restartHost;
                        }
                        catch (error) {
                            failure = error;
                        }
                        finally {
                            connection.socket.destroy();
                            // Restore the same native view, including its draft and overlay tree.
                            tui.start();
                            done();
                            tui.requestRender(true);
                        }
                    })().catch((error) => { failure = error; connection.socket.destroy(); done(); });
                });
                return { render: () => [], invalidate: () => { } };
            });
        }
        finally {
            connection.socket.destroy();
        }
        if (failure)
            throw failure;
        if (notice)
            ctx.ui.notify(notice, "info");
        if (launchError)
            ctx.ui.notify(launchError, "error");
        if (connection.hostNotice)
            ctx.ui.notify(connection.hostNotice, "info");
        // A managed view owns no process terminal. When the host chose to quit, Pi's own
        // orderly shutdown ends the frontend after the terminal has been restored.
        if (quitFrontend)
            ctx.shutdown();
        return restartHost;
    };
    const open = async (ctx, options = {}) => {
        if (!ctx.hasUI || ctx.mode !== "tui")
            throw new Error("/agents requires native interactive Pi");
        if (opening)
            return;
        // Any deliberate open consumes the startup attachment, so it cannot fire afterwards.
        launchPending = false;
        launchAttached = true;
        opening = true;
        try {
            while (await openOnce(ctx, options)) {
                // The host replaced itself from inside a managed view: start the installed build
                // and reconnect, so /agents restart is one command wherever it is typed.
                const replacement = await ensureNativeConnection(ctx.cwd, true, getAgentDir(), { autoUpdateHost: false });
                replacement.socket.end();
                ctx.ui.notify("Agent host restarted with the current build.", "info");
                options = { ...options, takeover: false };
            }
        }
        finally {
            opening = false;
        }
    };
    /** Launching Pi in a directory attaches it to a managed session for that directory. */
    const attachLaunchSession = (ctx) => {
        if (!launchPending || launchAttached || opening)
            return;
        // A startup dialog belongs to ordinary Pi. Wait for it instead of covering it.
        if (prompts > 0)
            return;
        launchPending = false;
        launchAttached = true;
        void open(ctx, { openBoard: false, launchCwd: ctx.cwd }).catch((error) => report(ctx, error));
    };
    const report = (ctx, error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    pi.registerCommand("agents", {
        description: "Open persistent native sessions; /agents [takeover|status|stop|restart]",
        handler: async (args, ctx) => {
            try {
                const command = args.trim();
                if (!command || command === "takeover") {
                    await open(ctx, { takeover: command === "takeover" });
                    return;
                }
                if (command === "leave") {
                    ctx.ui.notify("This Pi is already outside the managed host. Use /agents to connect.", "info");
                    return;
                }
                if (command === "restart") {
                    const probe = await ensureNativeConnection(ctx.cwd, false, getAgentDir());
                    let busy = 0;
                    let settledStop = false;
                    let safeUpdate = false;
                    let attached = false;
                    try {
                        const state = await probe.request("status");
                        busy = countUnsettled(state.sessions);
                        settledStop = state.capabilities?.includes("settledStop") === true;
                        safeUpdate = state.capabilities?.includes("safeUpdate") === true;
                        attached = state.attached;
                    }
                    finally {
                        probe.socket.end();
                    }
                    const reason = [busy ? `${busy} session(s) are running or waiting. Restarting aborts their runs and disposes pending dialogs.` : "",
                        attached ? "A frontend is attached. Restarting disconnects its terminal." : "",
                        settledStop ? "" : "This host predates settled-restart support: it may record settled sessions as Stopped.",
                        safeUpdate ? "" : "This host cannot atomically protect new work or attachments that appear during restart."].filter(Boolean).join(" ");
                    if (reason && !await ctx.ui.confirm("Restart the agent host?", reason))
                        return;
                    await stopNativeHost(getAgentDir(), { onlyIfSettled: !reason });
                    ctx.ui.notify("Agent host restarted with the current build.", "info");
                    await open(ctx);
                    return;
                }
                if (command !== "status" && command !== "stop") {
                    ctx.ui.notify("Usage: /agents [takeover|status|stop|restart|leave]. Create and resume sessions in the command center.", "info");
                    return;
                }
                if (command === "stop" && !await ctx.ui.confirm("Stop managed agents?", "Abort all managed runs and stop their host? Native history is retained."))
                    return;
                const connection = await ensureNativeConnection(ctx.cwd, false, getAgentDir());
                try {
                    if (command === "stop") {
                        await connection.request("stop");
                        ctx.ui.notify("Managed agent host is stopping.", "info");
                    }
                    else {
                        const state = await connection.request("status");
                        const stale = state.version === VERSION && state.buildId === BUILD_ID ? "" : ` · host build ${state.buildId?.slice(0, 8) ?? "unknown"}`;
                        ctx.ui.notify(`${statusParts(state.sessions).join(" · ")}${state.attached ? " · terminal attached" : ""}${stale}`, "info");
                    }
                }
                finally {
                    connection.socket.end();
                }
            }
            catch (error) {
                report(ctx, error);
            }
        },
    });
    // Pi reserves Ctrl+G for its external editor, so registerShortcut cannot
    // override it. The terminal-input hook runs before that built-in dispatch.
    pi.on("session_start", (event, ctx) => {
        removeInput?.();
        prompts = 0;
        if (ctx.mode !== "tui")
            return;
        let config;
        try {
            config = frontendConfig = Object.freeze(loadConfig(getAgentDir()));
        }
        catch (error) {
            report(ctx, error);
            return;
        }
        removeInput = ctx.ui.onTerminalInput((data) => {
            if (opening)
                return;
            const entry = commandCenterKey(config, data, ctx.ui.getEditorText() === "", prompts);
            if (!entry)
                return;
            void open(ctx).catch((error) => report(ctx, error));
            return { consume: true };
        });
        // Pi starts its UI before it initializes extensions, so the first session of this
        // process can take over its own terminal. Deferred so Pi finishes its own startup.
        if (config.autoAttach && !launchAttached && event.reason === "startup") {
            launchPending = true;
            launchCtx = ctx;
            queueMicrotask(() => attachLaunchSession(ctx));
        }
    });
    pi.on("ui_prompt_start", () => { prompts++; });
    pi.on("ui_prompt_end", () => {
        prompts = Math.max(0, prompts - 1);
        if (launchPending && launchCtx)
            attachLaunchSession(launchCtx);
    });
    pi.on("session_shutdown", () => { removeInput?.(); removeInput = undefined; });
}
//# sourceMappingURL=extension.js.map