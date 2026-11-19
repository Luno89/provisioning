import type { Client } from '@temporalio/client';
import { endingOf } from '../../platform/index.js';

export type DeploySettled = { ok: true } | { ok: false; reason: string };

export function deploySettledOn(client: () => Promise<Pick<Client, 'workflow'>>): (workflowId: string) => Promise<DeploySettled> {
  return async (workflowId) => {
    const ending = await endingOf((await client()).workflow.getHandle(workflowId));
    if ('failed' in ending) return { ok: false, reason: ending.failed };
    const verdict = ending.ended as { workload?: string; workloadReason?: string } | null;
    return verdict?.workload === 'unhealthy' ? { ok: false, reason: verdict.workloadReason || 'the app never became healthy' } : { ok: true };
  };
}
