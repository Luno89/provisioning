import type { WorkflowClient } from '@temporalio/client';
import type { RunStarter } from './registries/run-starter.js';
import { RUN_ID_MEMO, workflowOfRun } from './temporal/contracts.js';
import { closedWith, type ClosedAs } from '../platform/lib/workflow-close.js';
import type { ProvisionRuns } from '../infrastructure/index.js';

const notFound = (err: unknown): boolean => (err as { name?: string } | undefined)?.name === 'WorkflowNotFoundError' || /not\s*found/i.test(String((err as Error)?.message ?? err));

export function endedWhy(closed: { as: ClosedAs; why?: string | undefined }): string {
  switch (closed.as) {
    case 'FAILED':
      return `the setup's run failed: ${closed.why ?? 'it gave no reason'}`;
    case 'CANCELLED':
      return 'the setup\'s run was stopped';
    case 'TERMINATED':
      return 'the setup\'s run was ended from outside Koala';
    case 'NOT_FOUND':
      return closed.why ?? 'Temporal no longer has the setup\'s run';
    default:
      return 'the setup\'s run finished without saying how its pieces ended';
  }
}

export function engineProvisionRuns(deps: {
  runs: Pick<RunStarter, 'start'>;
  client: () => Pick<WorkflowClient, 'getHandle'> | undefined;
  agent: string;
}): ProvisionRuns {
  const handle = (workflowId: string) => {
    const client = deps.client();
    if (!client) throw new Error('Temporal is not reachable, so the setup\'s run cannot be followed');
    return client.getHandle(workflowId);
  };

  return {
    async start(input) {
      await deps.runs.start({
        ownerId: input.ownerId,
        agentSlug: deps.agent,
        message: 'Set Koala up.',
        runId: input.recordId,
        inputs: { ...input },
        startedBy: 'platform',
      });
      return workflowOfRun(input.recordId);
    },

    async started(runId) {
      const workflowId = workflowOfRun(runId);
      try {
        const described = await handle(workflowId).describe();
        return described.memo?.[RUN_ID_MEMO] === runId ? workflowId : undefined;
      } catch (err) {
        if (notFound(err)) return undefined;
        throw err;
      }
    },

    async ended(workflowId) {
      return endedWhy(await closedWith(handle(workflowId)));
    },
  };
}
