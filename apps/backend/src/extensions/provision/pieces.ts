import type { Client } from '@temporalio/client';
import { endingOf, failureReason } from '../../platform/index.js';
import type { ProvisionPieceResult } from '../../infrastructure/index.js';
import { provisionPieceStart } from '../../workflows/provision-piece.js';
import type { ProvisionPieces } from './operations/handlers.js';
import { PROVISION_PIECE_WORKFLOW } from './names.js';

export interface PieceWorkflows {
  client: () => Promise<Client>;
  queue: string;
}

const STOPPED = 'the run was stopped';

function resultOf(value: unknown, workflowId: string): ProvisionPieceResult {
  const answer = value as { ok?: unknown; why?: unknown } | null;
  if (answer?.ok === true) return { ok: true };
  if (answer?.ok === false && typeof answer.why === 'string' && answer.why) return { ok: false, why: answer.why };
  throw new Error(`${workflowId} answered ${JSON.stringify(value)}, which is not what a piece answers: ok, or not ok with why`);
}

export function provisionPiecesOn(workflows: PieceWorkflows): ProvisionPieces {
  return {
    async run(piece, signal) {
      const handle = await (await workflows.client()).workflow.start(PROVISION_PIECE_WORKFLOW, provisionPieceStart(piece, workflows.queue));
      let cancelling: Promise<unknown> | undefined;
      const cancel = () => { cancelling ??= handle.cancel().then(() => undefined, (err: unknown) => err); };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      const ended = await endingOf(handle).then(
        (ending): ProvisionPieceResult => ('failed' in ending ? { ok: false, why: signal?.aborted ? STOPPED : ending.failed } : resultOf(ending.ended, handle.workflowId)),
      ).finally(() => signal?.removeEventListener('abort', cancel));
      const refused = await cancelling;
      if (refused) throw new Error(`${handle.workflowId} could not be cancelled when the run was stopped: ${failureReason('FAILED', refused)}`, { cause: refused });
      return ended;
    },
  };
}
