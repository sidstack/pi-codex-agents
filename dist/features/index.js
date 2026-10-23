import { createNamingFeature } from "./naming.js";
import { createHistoryFeature } from "./history.js";
import { inactivityFeature } from "./inactivity.js";
import { navigationFeature } from "./navigation.js";
import { statusFeature } from "./status.js";
/** One assembly point; optional features never import each other. */
export function configuredFeatures(config) {
    return [
        ...(config.autoName ? [createNamingFeature({ nameModel: config.nameModel })] : []),
        ...(config.historyImport ? [createHistoryFeature()] : []),
        ...(config.autoInactive ? [inactivityFeature] : []),
        ...(config.commandCenterShortcut || config.leftArrowEntry || config.sessionCycling ? [navigationFeature] : []),
        ...(config.showStatus ? [statusFeature] : []),
    ];
}
//# sourceMappingURL=index.js.map