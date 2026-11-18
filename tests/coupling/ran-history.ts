import type { Ran } from './collect.js';
import type { Graph } from './graph.js';
import { unitsRanBy, type Judged } from './join.js';
import { callOf } from './rules.js';

export interface RanRecord { commit: string; at: string; ran: Record<string, string[]>; units: Record<string, string[]>; breaches: Record<string, number> }

export const KEPT_RECORDS = 5;
const TESTS_NAMED = 5;

export function ranIn(judged: readonly Judged[], graph: Graph): Record<string, string[]> {
  const byCall = new Map<string, Judged[]>();
  for (const entry of judged) {
    if (entry.edge.to.length === 0) continue;
    const call = callOf(entry.edge, graph);
    byCall.set(call, [...(byCall.get(call) ?? []), entry]);
  }
  const ran: Record<string, string[]> = {};
  for (const [call, sites] of byCall) {
    if (sites.some((site) => site.covered.length === 0)) continue;
    ran[call] = [...new Set(sites.flatMap((site) => site.covered.map((covered) => covered.test)))].sort().slice(0, TESTS_NAMED);
  }
  return ran;
}

export function unitsRanIn(graph: Graph, runs: readonly Ran[]): Record<string, string[]> {
  const units: Record<string, string[]> = {};
  for (const [id, tests] of unitsRanBy(graph, runs)) {
    const unit = graph.units[id];
    if (unit) units[`${unit.file}#${unit.name}`] = [...new Set(tests)].sort().slice(0, TESTS_NAMED);
  }
  return units;
}

export const kept = (history: readonly RanRecord[], latest: RanRecord): RanRecord[] => [latest, ...history].slice(0, KEPT_RECORDS);

const foundIn = (record: RanRecord, breachKey: string): boolean => (record.breaches?.[breachKey] ?? 0) > 0;

export function lastRan(history: readonly RanRecord[], breachKey: string): { commit: string; at: string; tests: string[] } | undefined {
  const rule = breachKey.slice(0, breachKey.indexOf(' '));
  const call = breachKey.slice(breachKey.indexOf(' ') + 1);
  for (const record of history) {
    if (foundIn(record, breachKey)) return undefined;
    const tests = rule === 'R5' ? record.units?.[call] : record.ran[call];
    if (tests) return { commit: record.commit, at: record.at, tests };
  }
  return undefined;
}

export function lastRanLine(history: readonly RanRecord[], breachKey: string): string {
  const last = lastRan(history, breachKey);
  const held = history.find((record) => foundIn(record, breachKey));
  if (!last && held) return `  the audit at ${held.commit} (${held.at}) found it too, so it holds between runs`;
  if (!last) return `  no audit of the last ${KEPT_RECORDS} ran it for real either`;
  return `  last run for real at ${last.commit} (${last.at}) by: ${last.tests.join(', ')}; this run did not, so what those tests do differs between runs`;
}
