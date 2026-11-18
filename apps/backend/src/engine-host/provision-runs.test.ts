import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { engineProvisionRuns, endedWhy } from './provision-runs.js';
import type { RunStarter, StartRunRequest, StartedRun } from './registries/run-starter.js';
import type { ProvisionRunInput } from '../infrastructure/index.js';

const INPUT: ProvisionRunInput = { ownerId: 'owner-1', recordId: 'provision-machine-desk~k1', target: { kind: 'koala', clusterId: 'machine-desk' }, revision: 4, reason: 'revision' };

describe('starting and following a Koala setup run in the engine', () => {
  it('starts the setup persona as the owner, the run id the record\'s, its inputs the run\'s, and answers the workflow it runs under', async () => {
    const runs = mock<Pick<RunStarter, 'start'>>();
    runs.start.mockImplementation(async (request: StartRunRequest): Promise<StartedRun> => ({ runId: request.runId!, agentSlug: request.agentSlug, loopId: 'provision' }));
    const provision = engineProvisionRuns({ runs, client: () => undefined, agent: 'provision' });

    expect(await provision.start(INPUT)).toBe('provision-machine-desk');
    expect(runs.start).toHaveBeenCalledWith({ ownerId: 'owner-1', agentSlug: 'provision', message: 'Set Koala up.', runId: INPUT.recordId, inputs: { ...INPUT }, startedBy: 'platform' });
  });

  it('answers the run\'s workflow when Temporal says that run has started already, as when another of Koala\'s processes started it', async () => {
    const runs = mock<Pick<RunStarter, 'start'>>();
    runs.start.mockRejectedValue(new WorkflowExecutionAlreadyStartedError('Workflow execution already started', 'provision-machine-desk', 'AgentRunWorkflow'));
    expect(await engineProvisionRuns({ runs, client: () => undefined, agent: 'provision' }).start(INPUT)).toBe('provision-machine-desk');
  });

  it('hands on any other refusal to start, for the run to be failed with it', async () => {
    const runs = mock<Pick<RunStarter, 'start'>>();
    runs.start.mockRejectedValue(new Error('There is no procedure called "provision".'));
    await expect(engineProvisionRuns({ runs, client: () => undefined, agent: 'provision' }).start(INPUT)).rejects.toThrow('There is no procedure called');
  });

  it('refuses to follow a run while Temporal cannot be reached, rather than saying how it ended', async () => {
    const provision = engineProvisionRuns({ runs: mock(), client: () => undefined, agent: 'provision' });
    await expect(provision.ended('provision-machine-desk')).rejects.toThrow('Temporal is not reachable');
  });

  it('says how a run ended in the words the card shows', () => {
    expect(endedWhy({ as: 'COMPLETED' })).toBe('the setup\'s run finished without saying how its pieces ended');
    expect(endedWhy({ as: 'FAILED', why: 'the activity could not reach the cluster' })).toBe('the setup\'s run failed: the activity could not reach the cluster');
    expect(endedWhy({ as: 'CANCELLED' })).toBe('the setup\'s run was stopped');
    expect(endedWhy({ as: 'TERMINATED' })).toBe('the setup\'s run was ended from outside Koala');
    expect(endedWhy({ as: 'NOT_FOUND', why: 'Temporal no longer has its workflow' })).toBe('Temporal no longer has its workflow');
  });
});
