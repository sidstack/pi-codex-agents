export function countUnsettled(rows) {
    return rows.filter((row) => row.running === true || (row.pendingOperations ?? 0) > 0 || (row.prompts ?? 0) > 0 ||
        row.activity === "running" || row.activity === "waiting" ||
        (row.activity === "failed" && (row.running === undefined || row.prompts === undefined))).length;
}
//# sourceMappingURL=activity.js.map