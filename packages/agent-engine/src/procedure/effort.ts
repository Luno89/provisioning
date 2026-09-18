import type { RunBudget } from '../runtime/run.js';

export interface RunEffort {
  runId: string;
  ownerId: string;
  parentRunId?: string | undefined;
  agentSlug: string;
  procedureId: string;
  procedureVersion: string;
  modelKey: string;
  modelLabel: string;
  outcome: string;
  reason?: string | undefined;
  rounds: number;
  toolCalls: number;
  totalTokens: number;
  childRuns: number;
  longestReply: number;
  cappedAt: number;
  steps: number;
  wallClockMs: number;
  ask: string;
  limits: RunBudget;
  finishedAt: string;
}

export const EFFORT_MEASURES = [
  { measure: 'rounds', limit: 'maxRounds' },
  { measure: 'toolCalls', limit: 'maxToolCalls' },
  { measure: 'totalTokens', limit: 'maxTokens' },
  { measure: 'childRuns', limit: 'maxChildRuns' },
  { measure: 'wallClockMs', limit: 'maxWallClockMs' },
] as const satisfies readonly { measure: keyof RunEffort; limit: keyof RunBudget }[];

export type EffortMeasure = (typeof EFFORT_MEASURES)[number]['measure'];

export const REPLY_MEASURE = 'longestReply' as const satisfies keyof RunEffort;

export const SUCCESSES_BEFORE_LIMITS = 5;
export const TYPICAL_PERCENTILE = 0.9;
export const HEADROOM = 1.4;
export const EFFORT_HISTORY = 50;
export const REPLY_GROWTH = 2;

export const LIMITS_ARE_ADVISORY = true;
export const ASK_CHARS = 2000;

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]!;
}

export interface TrackRecord {
  modelKey: string;
  modelLabel: string;
  runs: number;
  successes: number;
  typical: Record<EffortMeasure, number>;
  largestReply: number;
  cappedAt: number;
  replyCeiling: number | undefined;
  limits: RunBudget | undefined;
}

export function trackRecord(records: readonly RunEffort[]): TrackRecord | undefined {
  const newest = [...records].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  const latest = newest[0];
  if (!latest) return undefined;

  const successes = newest.filter((record) => record.outcome === 'ok').slice(0, EFFORT_HISTORY);
  const typical = Object.fromEntries(
    EFFORT_MEASURES.map(({ measure }) => [measure, percentile(successes.map((record) => record[measure]), TYPICAL_PERCENTILE)]),
  ) as Record<EffortMeasure, number>;

  const limits: RunBudget = {};
  if (successes.length >= SUCCESSES_BEFORE_LIMITS) {
    for (const { measure, limit } of EFFORT_MEASURES) {
      if (typical[measure] > 0) limits[limit] = Math.ceil(typical[measure] * HEADROOM);
    }
  }

  const largestReply = Math.max(0, ...successes.map((record) => record[REPLY_MEASURE] ?? 0));
  const cappedAt = Math.max(0, ...newest.slice(0, EFFORT_HISTORY).map((record) => record.cappedAt ?? 0));
  const settled = successes.length >= SUCCESSES_BEFORE_LIMITS;
  const fromSuccesses = largestReply > 0 ? Math.ceil(largestReply * HEADROOM) : 0;
  const room = Math.max(fromSuccesses, cappedAt * REPLY_GROWTH);

  return {
    modelKey: latest.modelKey,
    modelLabel: latest.modelLabel,
    runs: newest.length,
    successes: successes.length,
    typical,
    largestReply,
    cappedAt,
    replyCeiling: settled && room > 0 ? room : undefined,
    limits: settled ? limits : undefined,
  };
}

export function trackRecordsByModel(records: readonly RunEffort[]): TrackRecord[] {
  const byModel = new Map<string, RunEffort[]>();
  for (const record of records) byModel.set(record.modelKey, [...(byModel.get(record.modelKey) ?? []), record]);
  return [...byModel.values()]
    .map((group) => trackRecord(group)!)
    .sort((a, b) => b.runs - a.runs);
}

export function limitsFor(record: TrackRecord | undefined, explicit: RunBudget): RunBudget {
  if (LIMITS_ARE_ADVISORY) return { ...explicit };
  return { ...(record?.limits ?? {}), ...explicit };
}

export function replyCeilingFrom(records: readonly RunEffort[], agentSlug: string): number | undefined {
  const mine = [...records]
    .filter((record) => record.agentSlug === agentSlug)
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));

  return trackRecord(mine)?.replyCeiling;
}

export function replyCeilingFor(records: readonly RunEffort[], agentSlug: string): number | undefined {
  return LIMITS_ARE_ADVISORY ? undefined : replyCeilingFrom(records, agentSlug);
}
