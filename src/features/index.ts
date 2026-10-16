import type { Config } from "../config.js";
import type { SessionFeature } from "./contracts.js";
import { createNamingFeature } from "./naming.js";
import { createHistoryFeature } from "./history.js";
import { inactivityFeature } from "./inactivity.js";
import { navigationFeature } from "./navigation.js";
import { statusFeature } from "./status.js";

/** One assembly point; optional features never import each other. */
export function configuredFeatures(config: Readonly<Config>): SessionFeature[] {
  return [
    ...(config.autoName ? [createNamingFeature()] : []),
    ...(config.historyImport ? [createHistoryFeature()] : []),
    ...(config.autoInactive ? [inactivityFeature] : []),
    ...(config.commandCenterShortcut || config.leftArrowEntry || config.sessionCycling ? [navigationFeature] : []),
    ...(config.showStatus ? [statusFeature] : []),
  ];
}
