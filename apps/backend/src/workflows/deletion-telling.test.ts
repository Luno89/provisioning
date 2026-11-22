import { describe, expect, it } from 'vitest';
import { awaitStopped, type OnMachine, type Tell } from './deletion-telling.js';
import { deletionBegun, workStopping, type DeletionProgress } from '../projects/lib/project-deletion.js';
import type { FrozenWorkActivities } from '../activities/DeleteProjectActivities.js';

const run = { workflowId: 'run-1', type: 'AgentRunWorkflow', startedAt: '2026-11-21T10:00:00.000Z' };

const following = () => {
  let progress: DeletionProgress = workStopping(deletionBegun(), [run]);
  const tell: Tell = async (change) => { progress = change(progress); };
  return { tell, shown: () => progress.work[0] };
};

const frozenOn = (answer: 'restarted' | 'not-here'): FrozenWorkActivities => ({
  AwaitProjectWorkActivity: async () => ({ frozen: ['worker-engine-7d9f'], killed: [], machines: [] }),
  RestartWorkerActivity: async () => answer,
});

const noMachine: OnMachine = () => { throw new Error('no machine was off'); };

describe('waiting for a running thing to stop', () => {
  it('says its worker restarted once the restart answers restarted', async () => {
    const { tell, shown } = following();
    expect(await awaitStopped(run, tell, frozenOn('restarted'), noMachine)).toEqual(['worker-engine-7d9f']);
    expect(shown()).toMatchObject({ state: 'restarted', worker: 'worker-engine-7d9f' });
  });

  it('says its worker is gone when Kubernetes has no pod of that name, and counts nothing restarted', async () => {
    const { tell, shown } = following();
    expect(await awaitStopped(run, tell, frozenOn('not-here'), noMachine)).toEqual([]);
    expect(shown()).toMatchObject({ state: 'gone', worker: 'worker-engine-7d9f' });
  });

  it('on a machine that is off, says it will stop when the machine wakes, asks the machine\'s own queue to stop it, and shows it stopped with what the machine killed', async () => {
    const { tell, shown } = following();
    const asked: string[] = [];
    let wakes!: (answer: { killed: string[] }) => void;
    let askedOnce!: () => void;
    const askedMachine = new Promise<void>((done) => { askedOnce = done; });
    const onMachine: OnMachine = (deviceId) => ({
      StopMachineWorkActivity: ({ workflowIds }) => {
        asked.push(`${deviceId}: ${workflowIds.join(', ')}`);
        askedOnce();
        return new Promise((answered) => { wakes = answered; });
      },
    });
    const cluster: FrozenWorkActivities = {
      AwaitProjectWorkActivity: async () => ({ frozen: [], killed: [], machines: [{ id: 'desk', name: 'Desk' }] }),
      RestartWorkerActivity: async () => { throw new Error('a machine is never restarted as a pod'); },
    };
    const stopping = awaitStopped(run, tell, cluster, onMachine);
    await Promise.race([askedMachine, stopping.then(() => { throw new Error('it ended without asking the machine'); })]);
    expect(shown()).toMatchObject({ state: 'waiting-machine', machine: 'Desk' });
    expect(asked).toEqual(['desk: run-1']);
    wakes({ killed: ['claude'] });
    expect(await stopping).toEqual([]);
    expect(shown()).toMatchObject({ state: 'stopped', killed: ['claude'] });
  });
});
