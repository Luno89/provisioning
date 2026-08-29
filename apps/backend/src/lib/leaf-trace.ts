import type { AgentStep } from '@koala/harness-types';

export interface LeafTrace {
  id: string;
  ownerId: string;
  branchId: string;
  steps: AgentStep[];
  trimmed?: boolean;
  totalSteps: number;
  tokensUsed: number;
  checkpoints?: { step: number; tokensUsed: number; sha?: string; branch?: string }[];
  evidence?: LeafEvidence;
  createdAt: string;
}

export interface LeafEvidence {
  diff?: string;
  diffTruncated?: boolean;
  verifyOutput?: string;
  expects?: { path: string; content: string; truncated?: boolean }[];
  findings?: string;
  capturedAt: string;
}

export interface LeafChecks {
  verify: { command?: string; outcome: string };
  artifacts: { outcome: string; missing?: string[] };
  docker?: { problems: boolean };
  findings?: { outcome: string };
  combined: string;
  settled: string;
}

export const MAX_TRACE_CHARS = 120_000;

export const KEEP_OPENING = 3;

export function trimTrace(steps: AgentStep[], budget = MAX_TRACE_CHARS): { steps: AgentStep[]; trimmed: boolean } {
  const size = (s: AgentStep) => JSON.stringify(s).length;
  const total = steps.reduce((n, s) => n + size(s), 0);
  if (total <= budget) return { steps, trimmed: false };

  const opening = steps.slice(0, KEEP_OPENING);
  let used = opening.reduce((n, s) => n + size(s), 0);

  const tail: AgentStep[] = [];
  for (let i = steps.length - 1; i >= opening.length; i--) {
    const s = steps[i]!;
    const cost = size(s);
    if (used + cost > budget) break;
    used += cost;
    tail.unshift(s);
  }

  return { steps: [...opening, ...tail], trimmed: true };
}

export function droppedCount(trace: Pick<LeafTrace, 'steps' | 'totalSteps'>): number {
  return Math.max(0, trace.totalSteps - trace.steps.length);
}
