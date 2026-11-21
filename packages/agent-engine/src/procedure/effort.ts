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

export const EFFORT_MEASURES = ['rounds', 'toolCalls', 'totalTokens', 'childRuns', 'wallClockMs'] as const satisfies readonly (keyof RunEffort)[];

export type EffortMeasure = (typeof EFFORT_MEASURES)[number];

export const REPLY_MEASURE = 'longestReply' as const satisfies keyof RunEffort;

export const TYPICAL_PERCENTILE = 0.9;
export const EFFORT_HISTORY = 50;

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
}

export function trackRecord(records: readonly RunEffort[]): TrackRecord | undefined {
  const newest = [...records].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  const latest = newest[0];
  if (!latest) return undefined;

  const successes = newest.filter((record) => record.outcome === 'ok').slice(0, EFFORT_HISTORY);
  const typical = Object.fromEntries(
    EFFORT_MEASURES.map((measure) => [measure, percentile(successes.map((record) => record[measure]), TYPICAL_PERCENTILE)]),
  ) as Record<EffortMeasure, number>;

  const largestReply = Math.max(0, ...successes.map((record) => record[REPLY_MEASURE] ?? 0));
  const cappedAt = Math.max(0, ...newest.slice(0, EFFORT_HISTORY).map((record) => record.cappedAt ?? 0));

  return {
    modelKey: latest.modelKey,
    modelLabel: latest.modelLabel,
    runs: newest.length,
    successes: successes.length,
    typical,
    largestReply,
    cappedAt,
  };
}

export function trackRecordsByModel(records: readonly RunEffort[]): TrackRecord[] {
  const byModel = new Map<string, RunEffort[]>();
  for (const record of records) byModel.set(record.modelKey, [...(byModel.get(record.modelKey) ?? []), record]);
  return [...byModel.values()]
    .map((group) => trackRecord(group)!)
    .sort((a, b) => b.runs - a.runs);
}
