import type { Activity } from "../core/fleet.js";
import type { SessionFeature } from "./contracts.js";

export interface StatusRow {
  activity: Activity;
  unread?: boolean;
}

/** The same activity vocabulary the command center chips use. */
export function statusParts(rows: readonly StatusRow[]): string[] {
  const count = (activity: Activity) => rows.reduce((total, row) => total + (row.activity === activity ? 1 : 0), 0);
  const parts = [`sessions ${rows.length}`, `${count("running")} running`, `${count("waiting")} needs input`, `${count("ready")} ready`];
  // Extra groups appear only when they would otherwise be hidden inside the total.
  const failed = count("failed");
  const settled = count("inactive") + count("stopped");
  const unread = rows.filter((row) => row.unread).length;
  if (failed) parts.push(`${failed} failed`);
  if (settled) parts.push(`${settled} inactive`);
  if (unread) parts.push(`${unread} unread`);
  return parts;
}

export const statusFeature: SessionFeature = {
  id: "status",
  changed(host) {
    const rows = [...host.sessions.values()];
    const summary = statusParts(rows).join(" · ");
    const entry = host.config.commandCenterShortcut ? "Ctrl+G" : "/agents";
    for (const row of rows) row.context?.ui.setStatus("pi-codex-agents-native", `${summary} · ${entry}`);
  },
};
