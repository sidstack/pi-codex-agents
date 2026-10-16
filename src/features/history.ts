import { join } from "node:path";
import { NativeHistoryScanner, type HistoryDiscovery } from "./history-source.js";
import type { NativeSessionHost } from "../core/sessions.js";
import type { SessionFeature } from "./contracts.js";

export function createHistoryFeature(): SessionFeature {
  const scanner = new NativeHistoryScanner();
  let pending: Promise<HistoryDiscovery> | undefined;
  let lastIssues = "";
  let closed = false;
  function scan(host: NativeSessionHost): Promise<HistoryDiscovery> {
    if (closed) return Promise.resolve({ sessions: [], issues: [] });
    if (pending) return pending;
    const managed = new Set([...host.sessions.values()].flatMap((row) => row.sessionFile ? [row.sessionFile] : []));
    pending = scanner.scan(join(host.agentDir, "sessions"), managed).then((result) => {
      if (closed) { scanner.clear(); return { sessions: [], issues: [] }; }
      const signature = [...result.issues].sort().join("\n");
      if (signature !== lastIssues) {
        lastIssues = signature;
        if (signature) {
          const message = `History discovery is partial (${result.issues.length} issues). ${result.issues.slice(0, 3).join("; ")}`;
          console.error(message);
          host.sessions.get(host.activeId)?.context?.ui.notify(message, "warning");
        }
      }
      return result;
    }).finally(() => { pending = undefined; });
    return pending;
  }
  return {
    id: "history",
    start: () => () => { closed = true; scanner.clear(); lastIssues = ""; },
    async refresh(host) {
      const { sessions } = await scan(host);
      const known = new Set([...host.sessions.values()].flatMap((row) => [row.sourceFile, row.sessionFile]).filter(Boolean));
      let changed = false;
      const available = new Set(sessions.map((history) => history.sourceFile));
      for (const [id, row] of host.sessions) {
        if (row.sourceFile && !row.sessionFile && !row.view && !available.has(row.sourceFile)) {
          host.sessions.delete(id); changed = true;
        }
      }
      for (const history of sessions) {
        const existing = host.sessions.get(history.id);
        if (existing?.sourceFile === history.sourceFile && !existing.sessionFile && !existing.view) {
          if (existing.name !== history.name || existing.cwd !== history.cwd) {
            existing.name = history.name; existing.cwd = history.cwd; changed = true;
          }
          continue;
        }
        if (known.has(history.sourceFile) || existing) continue;
        host.sessions.set(history.id, { ...history, activity: "inactive", running: false, prompts: 0, unread: false });
        changed = true;
      }
      if (changed) host.onChange();
    },
    async history(host, path) { return (await scan(host)).sessions.find((row) => row.sourceFile === path); },
  };
}
