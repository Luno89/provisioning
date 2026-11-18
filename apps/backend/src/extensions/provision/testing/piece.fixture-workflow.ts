import { ApplicationFailure, condition } from '@temporalio/workflow';

interface PieceInput {
  recordId: string;
  piece: string;
}

export async function ProvisionPieceWorkflow(input: PieceInput): Promise<unknown> {
  const say = input.recordId.split('~').at(-1);
  if (say === 'refused' && input.piece === 'gitea') return { ok: false, why: 'pod gitea-0 is Init:Error: the volume is full' };
  if (say === 'broken' && input.piece === 'infisical') throw ApplicationFailure.nonRetryable('the chart infisical-standalone 1.12.0 could not be read');
  if (say === 'garbled') return { done: true };
  if (say === 'held') await condition(() => false);
  return { ok: true };
}
