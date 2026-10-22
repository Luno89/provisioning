import type { NodeTrace } from '@koala/agent-engine/procedure';

export interface StoredNodeTrace extends NodeTrace {
  runId: string;
  ownerId: string;
  agentSlug: string;
  procedureId: string;
  procedureVersion: string;
}

export const runTraceKey = (runId: string, sequence: number): string => `${runId}:${String(sequence).padStart(6, '0')}`;

export function modelsOf(traces: readonly { kind?: string | undefined; outputs?: unknown }[]): string[] {
  const names = traces
    .filter((trace) => trace.kind === 'choose-model')
    .map((trace) => (trace.outputs as { binding?: { model?: unknown } } | undefined)?.binding?.model)
    .filter((model): model is string => typeof model === 'string' && model.length > 0);
  return [...new Set(names)];
}
