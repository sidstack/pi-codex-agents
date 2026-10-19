import { basename } from "node:path";

/**
 * Score how well a query matches a path, case-insensitively.
 * Higher is better; negative means no match; empty query scores 0.
 * Basename ranking: exact > prefix > substring > ordered subsequence,
 * with full-path substring as a lower-priority fallback.
 */
export function scorePathMatch(query: string, path: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = basename(path).toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  let matched = 0;
  for (const ch of name) {
    if (ch === q[matched]) matched += 1;
    if (matched === q.length) return 40;
  }
  if (path.toLowerCase().includes(q)) return 20;
  return -1;
}
