/** Pi exports no public live-view attachment API, so the native host depends on guarded
 * private `InteractiveMode` members. Every supported minor needs its own adapter check:
 * 1.3.x keeps one extension selector/input/editor field each, while 1.4.x replaced them
 * with the `extensionDialogs` stack (earendil-works/pi#11166). `nativePromptCancellation`
 * accepts both shapes, so patch releases share the guarded contract and a new minor only
 * needs validation plus a widened range here. */
export const PI_VERSION_RANGE = ">=1.3.0 <1.5.0";
/** Names a private Pi member this package adapts, with the versions it was validated on. */
export function unsupportedContract(contract) {
    return `Unsupported Pi contract: ${contract}. pi-codex-agents validates Pi ${PI_VERSION_RANGE}.`;
}
export function supportedPiVersion(version) {
    return /^1\.(3|4)\.(0|[1-9]\d*)$/.test(version);
}
//# sourceMappingURL=pi-version.js.map