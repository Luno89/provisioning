import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export type TimedKind = 'step' | 'check' | 'file';

export interface Timed {
  at: string;
  commit: string;
  kind: TimedKind;
  name: string;
  seconds: number;
}

export const TIMINGS_FILE = 'timings.jsonl';

export const SLOWER = { factor: 1.5, atLeastSeconds: 60, runs: 5 } as const;

export function keepTimings(file: string, rows: readonly Timed[]): void {
  if (rows.length > 0) appendFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
}

export function timingsIn(file: string): Timed[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Timed);
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const shown = (seconds: number): string => (seconds >= 120 ? `${(seconds / 60).toFixed(1)} min` : `${Math.round(seconds)} s`);

export function slowerThanUsual(history: readonly Timed[], commit: string): string[] {
  const latest = new Map<string, Timed>();
  const before = new Map<string, Timed[]>();
  for (const row of history) {
    const key = `${row.kind} ${row.name}`;
    if (row.commit === commit) latest.set(key, row);
    else before.set(key, [...(before.get(key) ?? []), row]);
  }
  const slower: string[] = [];
  for (const [key, now] of latest) {
    const earlier = [...new Map((before.get(key) ?? []).map((row) => [row.commit, row])).values()].slice(-SLOWER.runs);
    if (earlier.length === 0) continue;
    const usual = median(earlier.map((row) => row.seconds));
    if (now.seconds >= usual * SLOWER.factor && now.seconds - usual >= SLOWER.atLeastSeconds) {
      slower.push(`${now.kind} ${now.name}: ${shown(now.seconds)}, usually ${shown(usual)} over its last ${earlier.length} run${earlier.length === 1 ? '' : 's'}`);
    }
  }
  return slower.sort();
}
