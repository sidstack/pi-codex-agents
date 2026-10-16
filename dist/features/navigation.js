import { matchesKey } from "@earendil-works/pi-tui";
export function commandCenterKey(config, data, empty, prompts) {
    return (config.commandCenterShortcut && matchesKey(data, "ctrl+g")) ||
        (config.leftArrowEntry && matchesKey(data, "left") && empty && prompts === 0);
}
export const navigationFeature = {
    id: "navigation",
    input(host, record, ctx, data) {
        let task;
        if (commandCenterKey(host.config, data, ctx.ui.getEditorText() === "", record.prompts))
            task = host.open(ctx);
        else if (host.config.sessionCycling && (matchesKey(data, "ctrl+alt+n") || matchesKey(data, "ctrl+alt+p"))) {
            task = host.cycle(matchesKey(data, "ctrl+alt+n") ? 1 : -1);
        }
        else
            return;
        void task.catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
        return { consume: true };
    },
};
//# sourceMappingURL=navigation.js.map