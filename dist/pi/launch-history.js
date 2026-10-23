/** Pi flags that make the launch itself choose a history, before any extension runs. */
const HISTORY_FLAGS = new Set(["--session", "--session-id", "--continue", "-c", "--resume", "-r", "--fork"]);
/**
 * Pi flags that consume the next token as text. Skipping their value keeps a name or model that
 * looks like a flag (`pi --name -c`) from reading as a resumed launch. Pi owns the real parser;
 * this only guards the obvious false positives.
 */
const VALUE_FLAGS = new Set(["--mode", "--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt", "--name", "-n", "--session", "--session-id", "--fork", "--session-dir", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking"]);
/**
 * The history a freshly launched Pi already opened: `pi --session <id>`, `--session-id <id>`,
 * `-c`, `-r`, or `--fork <id>`. Pi builds that session before it initializes extensions, so the
 * frontend's own `session_start` still reports reason `"startup"` for it: the opened history and
 * the launch flags, not the event, say whether this launch named a session.
 *
 * Returning nothing means a plain launch with a new history, where the frontend's directory decides.
 * A launch that names an id no history has (`--session-id <new>`) opened an empty file; the flag
 * still counts, because the user asked for that id and the host can own it.
 */
export function launchedHistory(ctx, argv = process.argv) {
    let namedHistory = false;
    let skipValue = false;
    for (const arg of argv.slice(1)) {
        // Pi reads everything after `--` as text, never as flags.
        if (arg === "--")
            break;
        if (skipValue) {
            skipValue = false;
            continue;
        }
        if (HISTORY_FLAGS.has(arg)) {
            namedHistory = true;
            break;
        }
        skipValue = VALUE_FLAGS.has(arg);
    }
    // An opened history with entries is a resume even when no flag names one.
    const hasHistory = ctx.sessionManager.getLeafEntry() !== undefined;
    if (!namedHistory && !hasHistory)
        return undefined;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (typeof sessionFile !== "string" || !sessionFile.startsWith("/"))
        return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    return { sessionFile, ...(typeof sessionId === "string" && sessionId ? { sessionId } : {}) };
}
//# sourceMappingURL=launch-history.js.map