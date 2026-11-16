import type { Graph } from './graph.js';
import type { Judged } from './join.js';
import { callOf } from './rules.js';

export interface RanRecord { commit: string; at: string; ran: Record<string, string[]>; breaches: Record<string, number> }

export const KEPT_RECORDS = 5;
const TESTS_NAMED = 5;

export function ranIn(judged: readonly Judged[], graph: Graph): Record<string, string[]> {
  const ran: Record<string, string[]> = {};
  for (const entry of judged) {
    if (entry.covered.length === 0 || entry.edge.to.length === 0) continue;
    const tests = [...new Set(entry.covered.map((covered) => covered.test))].sort().slice(0, TESTS_NAMED);
    ran[callOf(entry.edge, graph)] = tests;
  }
  return ran;
}

export const kept = (history: readonly RanRecord[], latest: RanRecord): RanRecord[] => [latest, ...history].slice(0, KEPT_RECORDS);

export function lastRan(history: readonly RanRecord[], breachKey: string): { commit: string; at: string; tests: string[] } | undefined {
  const call = breachKey.slice(breachKey.indexOf(' ') + 1);
  for (const record of history) {
    const tests = record.ran[call];
    if (tests) return { commit: record.commit, at: record.at, tests };
  }
  return undefined;
}

export function lastRanLine(history: readonly RanRecord[], breachKey: string): string {
  const last = lastRan(history, breachKey);
  if (!last) return `  no audit of the last ${KEPT_RECORDS} ran it for real either`;
  return `  last run for real at ${last.commit} (${last.at}) by: ${last.tests.join(', ')}; this run did not, so what those tests do differs between runs`;
}
