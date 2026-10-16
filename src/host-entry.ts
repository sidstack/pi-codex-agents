import { registerInstalledSdk } from "./pi/sdk-loader.js";
registerInstalledSdk(process.env.PI_AGENTS_PI_ROOT);
const [{ startNativeDaemon }, { loadConfig }, { configuredFeatures }] = await Promise.all([
  import("./core/host.js"), import("./config.js"), import("./features/index.js"),
]);
const config = Object.freeze(loadConfig());
await startNativeDaemon(process.argv[2] ?? process.cwd(), config, configuredFeatures(config));
