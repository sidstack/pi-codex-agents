import { matchesKey } from "@earendil-works/pi-tui";
import type { Config } from "../config.js";
import type { SessionFeature } from "./contracts.js";

export function commandCenterKey(config: Readonly<Config>, data: string, empty: boolean, prompts: number): boolean {
  return (config.commandCenterShortcut && matchesKey(data, "ctrl+g")) ||
    (config.leftArrowEntry && matchesKey(data, "left") && empty && prompts === 0);
}

export const navigationFeature: SessionFeature = {
  id: "navigation",
  input(host, record, ctx, data) {
    let task: Promise<void>;
    if (commandCenterKey(host.config, data, ctx.ui.getEditorText() === "", record.prompts)) task = host.open(ctx);
    else if (host.config.sessionCycling && (matchesKey(data, "ctrl+alt+n") || matchesKey(data, "ctrl+alt+p"))) {
      task = host.cycle(matchesKey(data, "ctrl+alt+n") ? 1 : -1);
    } else return;
    void task.catch((error: unknown) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
    return { consume: true };
  },
};
