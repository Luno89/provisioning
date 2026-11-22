import { describe, expect, it } from 'vitest';
import { awaitStopped, type Tell } from './deletion-telling.js';
import { deletionBegun, workStopping, type DeletionProgress } from '../projects/lib/project-deletion.js';
import type { FrozenWorkActivities } from '../activities/DeleteProjectActivities.js';

const run = { workflowId: 'run-1', type: 'AgentRunWorkflow', startedAt: '2026-11-21T10:00:00.000Z' };

const following = () => {
  let progress: DeletionProgress = workStopping(deletionBegun(), [run]);
  const tell: Tell = async (change) => { progress = change(progress); };
  return { tell, shown: () => progress.work[0] };
};

const frozenOn = (answer: 'restarted' | 'not-here'): FrozenWorkActivities => ({
  AwaitProjectWorkActivity: async () => ({ frozen: ['worker-engine-7d9f'], killed: [] }),
  RestartWorkerActivity: async () => answer,
});

describe('waiting for a running thing to stop', () => {
  it('says its worker restarted once the restart answers restarted', async () => {
    const { tell, shown } = following();
    expect(await awaitStopped(run, tell, frozenOn('restarted'))).toEqual(['worker-engine-7d9f']);
    expect(shown()).toMatchObject({ state: 'restarted', worker: 'worker-engine-7d9f' });
  });

  it('says its worker is gone when Kubernetes has no pod of that name, and counts nothing restarted', async () => {
    const { tell, shown } = following();
    expect(await awaitStopped(run, tell, frozenOn('not-here'))).toEqual([]);
    expect(shown()).toMatchObject({ state: 'gone', worker: 'worker-engine-7d9f' });
  });
});
