import { registerInstalledSdk } from "./pi/sdk-loader.js";

// Both spellings are accepted: an older frontend still exports the short names when it
// starts this build, and a newer frontend exports both.
registerInstalledSdk(process.env.PI_CODEX_AGENTS_PI_ROOT ?? process.env.PI_AGENTS_PI_ROOT);
const [{ startNativeDaemon }, { configuredFeatures }, { loadConfig, prepareAppDirectory }] = await Promise.all([
  import("./core/host.js"), import("./features/index.js"), import("./config.js"),
]);
// A manually started host moves its own state directory too; host.log records the outcome.
const state = prepareAppDirectory();
if (state.notice) console.log(`pi-codex-agents host: ${state.notice}`);
const config = Object.freeze(loadConfig());
await startNativeDaemon(process.argv[2] ?? process.cwd(), config, configuredFeatures(config));
