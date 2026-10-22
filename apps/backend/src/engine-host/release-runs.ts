import type { WorkflowClient } from '@temporalio/client';
import type { StartRunRequest, StartedRun } from './registries/run-starter.js';
import { runStamp } from './temporal/contracts.js';
import { DECISION_NODE, releaseRunId, releaseRunWorkflowId } from '../releases/lib/release-run.js';
import type { ReleaseRuns } from '../releases/index.js';

const notFound = (err: unknown): boolean => /not\s*found/i.test(String((err as Error)?.message ?? err));

export function engineReleaseRuns(deps: {
  runs: { start(request: StartRunRequest): Promise<StartedRun> };
  client: () => Pick<WorkflowClient, 'getHandle'> | undefined;
}): ReleaseRuns {
  const handle = (projectId: string) => {
    const client = deps.client();
    if (!client) throw new Error('Temporal is not reachable, so the release cannot be reached');
    return client.getHandle(releaseRunWorkflowId(projectId));
  };

  return {
    async start({ projectId, ownerId, agent, inputs }) {
      await deps.runs.start({
        ownerId,
        agentSlug: agent,
        message: 'Release the build.',
        runId: releaseRunId(projectId, runStamp()),
        inputs: inputs as unknown as Record<string, unknown>,
        bound: { projectId },
      });
    },

    async running(projectId) {
      try {
        return (await handle(projectId).describe()).status.name === 'RUNNING';
      } catch (err) {
        if (notFound(err)) return false;
        throw err;
      }
    },

    async answer(projectId, choice, nodeId = DECISION_NODE) {
      await handle(projectId).signal('answer', { nodeId, value: choice });
    },

    async stop(projectId) {
      await handle(projectId).signal('cancelRun');
    },
  };
}
