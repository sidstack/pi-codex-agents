import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
export const DEFAULT_CONFIG = Object.freeze({
    autoName: true, historyImport: true, autoAttach: false, leftArrowEntry: true, commandCenterShortcut: true,
    sessionCycling: true, showStatus: true, autoInactive: true, autoUpdateHost: true,
    boardFullscreen: true, idleTimeoutMs: 3_600_000,
});
export function appDirectory(agentDir = getAgentDir()) {
    return resolve(process.env.PI_AGENTS_DIR ?? join(agentDir, "pi-agents"));
}
export function loadConfig(agentDir = getAgentDir()) {
    const path = join(appDirectory(agentDir), "config.json");
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            raw = {};
        else
            throw new Error(`Cannot read pi-agents config at ${path}: ${error.message}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("pi-agents config must be an object");
    const config = { ...DEFAULT_CONFIG };
    for (const [key, value] of Object.entries(raw)) {
        if (!Object.hasOwn(config, key))
            throw new Error(`Unknown pi-agents config option: ${key}`);
        if (key === "idleTimeoutMs") {
            if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
                throw new Error("idleTimeoutMs must be a non-negative integer");
            config.idleTimeoutMs = value;
        }
        else {
            if (typeof value !== "boolean")
                throw new Error(`${key} must be a boolean`);
            config[key] = value;
        }
    }
    if (process.env.PI_AGENTS_IDLE_MS !== undefined) {
        const value = Number(process.env.PI_AGENTS_IDLE_MS);
        if (!Number.isSafeInteger(value) || value < 0)
            throw new Error("PI_AGENTS_IDLE_MS must be a non-negative integer");
        config.idleTimeoutMs = value;
    }
    return config;
}
//# sourceMappingURL=config.js.map