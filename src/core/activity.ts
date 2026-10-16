/** Wire snapshots from older hosts may lack the independent lifecycle fields. */
export interface ActivitySnapshot {
  activity: string;
  running?: boolean;
  prompts?: number;
  pendingOperations?: number;
}

export function countUnsettled(rows: readonly ActivitySnapshot[]): number {
  return rows.filter((row) => row.running === true || (row.pendingOperations ?? 0) > 0 || (row.prompts ?? 0) > 0 ||
    row.activity === "running" || row.activity === "waiting" ||
    (row.activity === "failed" && (row.running === undefined || row.prompts === undefined))).length;
}
