import { registerHooks } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PI_VERSION_RANGE, supportedPiVersion } from "../pi-version.js";
/** Resolve detached control/host peers from the actual Pi installation. */
export function registerInstalledSdk(root) {
    if (!root)
        throw new Error("Missing Pi SDK location (PI_CODEX_AGENTS_PI_ROOT)");
    const sdkRoot = realpathSync(root);
    const pkg = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
    if (pkg.name !== "@earendil-works/pi-coding-agent" || !pkg.version || !supportedPiVersion(pkg.version))
        throw new Error(`The pi-codex-agents native host requires the npm-installed Pi ${PI_VERSION_RANGE} SDK`);
    const parentURL = pathToFileURL(join(sdkRoot, "dist", "index.js")).href;
    registerHooks({ resolve(specifier, context, nextResolve) {
            const provided = specifier.startsWith("@earendil-works/pi-") || specifier === "typebox" || specifier.startsWith("typebox/");
            return nextResolve(specifier, provided ? { ...context, parentURL } : context);
        } });
}
//# sourceMappingURL=sdk-loader.js.map