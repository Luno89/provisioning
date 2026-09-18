import type { NodeTrace } from '@koala/agent-engine/procedure';

export interface StoredNodeTrace extends NodeTrace {
  runId: string;
  ownerId: string;
  agentSlug: string;
  procedureId: string;
  procedureVersion: string;
}

export const runTraceKey = (runId: string, sequence: number): string => `${runId}:${String(sequence).padStart(6, '0')}`;
