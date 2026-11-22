import { describe, it, expect } from 'vitest';
import {
  deletionBegun,
  workStopping,
  workClosed,
  workerRestarted,
  machineWorkStopped,
  partDeleting,
  partDeleted,
  appRemoved,
  deletionEnded,
  deletionStuck,
  laterThan,
  namedWork,
  serviceBack,
  serviceDown,
} from './project-deletion.js';

const run = { workflowId: 'run-1', type: 'AgentRunWorkflow', startedAt: '2026-11-21T10:00:00.000Z' };
const build = { workflowId: 'build-1', type: 'executePipelineRunWorkflow', startedAt: '2026-11-21T10:01:00.000Z' };

describe('what a project being deleted shows as it goes', () => {
  it('lists each running thing as stopping, then stopped once Temporal says it closed', () => {
    const stopping = workStopping(deletionBegun(), [run, build]);
    expect(stopping.work.map((item) => [item.workflowId, item.state])).toEqual([['run-1', 'stopping'], ['build-1', 'stopping']]);
    const closed = workClosed(stopping, 'run-1', []);
    expect(closed.work.map((item) => [item.workflowId, item.state])).toEqual([['run-1', 'stopped'], ['build-1', 'stopping']]);
  });

  it('shows a worker that did not answer as restarting, and restarted only once its restart is reported', () => {
    const closed = workClosed(workStopping(deletionBegun(), [run]), 'run-1', ['worker-engine-7d9f']);
    expect(closed.work[0]).toMatchObject({ state: 'restarting', worker: 'worker-engine-7d9f' });
    expect(workerRestarted(closed, 'worker-engine-7d9f', 'restarted').work[0]).toMatchObject({ state: 'restarted', worker: 'worker-engine-7d9f' });
  });

  it('shows work on a machine that is off as waiting for it to wake, never stopped first, and stopped with what the machine killed once it answers', () => {
    const waiting = workClosed(workStopping(deletionBegun(), [run, build]), 'run-1', [], [], ['Desk']);
    expect(waiting.work[0]).toMatchObject({ state: 'waiting-machine', machine: 'Desk' });
    const stopped = machineWorkStopped(waiting, 'run-1', ['claude']);
    expect(stopped.work.map((item) => [item.workflowId, item.state, item.killed])).toEqual([['run-1', 'stopped', ['claude']], ['build-1', 'stopping', undefined]]);
    expect(machineWorkStopped(waiting, 'run-1', []).work[0]).not.toHaveProperty('killed');
  });

  it('shows a worker Kubernetes has no pod for as gone, never as restarted', () => {
    const closed = workClosed(workStopping(deletionBegun(), [run]), 'run-1', ['worker-engine-7d9f']);
    expect(workerRestarted(closed, 'worker-engine-7d9f', 'not-here').work[0]).toMatchObject({ state: 'gone', worker: 'worker-engine-7d9f' });
  });

  it('names the programs that were killed when a running thing stopped', () => {
    const closed = workClosed(workStopping(deletionBegun(), [run, build]), 'run-1', [], ['terraform', 'kubectl']);
    expect(closed.work.map((item) => [item.workflowId, item.state, item.killed])).toEqual([['run-1', 'stopped', ['terraform', 'kubectl']], ['build-1', 'stopping', undefined]]);
    expect(workClosed(workStopping(deletionBegun(), [run]), 'run-1', ['worker-engine-7d9f'], ['git']).work[0]).toMatchObject({ state: 'restarting', killed: ['git'] });
    expect(workClosed(workStopping(deletionBegun(), [run]), 'run-1', [], []).work[0]).not.toHaveProperty('killed');
  });

  it('adds work a later pass found without listing what it already shows twice', () => {
    const again = workStopping(workClosed(workStopping(deletionBegun(), [run]), 'run-1', []), [run, build]);
    expect(again.work.map((item) => [item.workflowId, item.state])).toEqual([['run-1', 'stopped'], ['build-1', 'stopping']]);
  });

  it('counts apps going down one by one, and other parts as deleting until their count is known', () => {
    const counted = partDeleting(deletionBegun(), 'apps', 2);
    expect(counted.parts.apps).toEqual({ state: 'deleting', left: 2, deleted: 0 });
    const one = appRemoved(counted);
    expect(one.parts.apps).toEqual({ state: 'deleting', left: 1, deleted: 1 });
    expect(partDeleted(appRemoved(one), 'apps', 0).parts.apps).toEqual({ state: 'deleted', left: 0, deleted: 2 });
    const workspaces = partDeleting(one, 'workspaces');
    expect(workspaces.parts.workspaces).toEqual({ state: 'deleting', deleted: 0 });
    expect(partDeleted(workspaces, 'workspaces', 3).parts.workspaces).toEqual({ state: 'deleted', left: 0, deleted: 3 });
  });

  it('adds what a later pass deleted to what was deleted before', () => {
    const first = partDeleted(partDeleting(deletionBegun(), 'workspaces'), 'workspaces', 2);
    expect(partDeleted(partDeleting(first, 'workspaces'), 'workspaces', 1).parts.workspaces).toEqual({ state: 'deleted', left: 0, deleted: 3 });
  });

  it('ends archived with the date it is kept until, or deleted for good', () => {
    expect(deletionEnded(deletionBegun(), { phase: 'archived', keptUntil: '2027-02-19T10:00:00.000Z' })).toMatchObject({ phase: 'archived', keptUntil: '2027-02-19T10:00:00.000Z' });
    expect(deletionEnded(deletionBegun(), { phase: 'deleted' }).phase).toBe('deleted');
  });

  it('shows a service it needs as down, since when and why, until the step that waited on it carries on', () => {
    const infisical = { step: 'RemoveProjectSecretsActivity', dependency: 'infisical', name: 'Infisical', since: '2026-11-21T10:05:00.000Z', reason: 'it cannot be reached: ECONNREFUSED' };
    const down = serviceDown(partDeleting(deletionBegun(), 'secrets'), infisical);
    expect(down).toMatchObject({ phase: 'deleting', down: [infisical] });
    expect(serviceDown(down, { ...infisical, reason: 'it answered 503' }).down).toEqual([{ ...infisical, reason: 'it answered 503' }]);
    expect(partDeleting(down, 'files').down, 'other changes keep it shown').toEqual([infisical]);
    expect(serviceBack(down, 'RemoveProjectSecretsActivity').down).toEqual([]);
    expect(serviceBack(down, 'RemoveProjectFilesActivity').down).toEqual([infisical]);
  });

  it('stays deleting with why when a part can never be deleted, and loses the why once it is tried again', () => {
    const stuck = deletionStuck(deletionBegun(), 'Gitea refused: 403 on koala-bo/shop');
    expect(stuck).toMatchObject({ phase: 'deleting', problem: 'Gitea refused: 403 on koala-bo/shop' });
    expect(workStopping(stuck, []).problem).toBeUndefined();
  });

  it('numbers every change so a late copy never replaces a newer one', () => {
    const first = workStopping(deletionBegun(), [run]);
    const second = workClosed(first, 'run-1', []);
    expect(laterThan(second, first)).toBe(true);
    expect(laterThan(first, second)).toBe(false);
    expect(laterThan(first, undefined)).toBe(true);
  });

  it('numbers a deletion tried again after everything the try before it told', () => {
    const before = deletionStuck(workStopping(deletionBegun(1_000), [run]), 'Gitea refused');
    const again = deletionBegun(2_000);
    expect(laterThan(again, before)).toBe(true);
    expect(again.problem).toBeUndefined();
  });

  it('names each running thing once, keeping a name given before even after its records are gone', () => {
    const named = namedWork(workStopping(deletionBegun(), [run, build]), (work) => (work.workflowId === 'run-1' ? 'Tree run: Grow the tree' : 'Building a project'));
    expect(named.work.map((item) => item.what)).toEqual(['Tree run: Grow the tree', 'Building a project']);
    const unnamed = workClosed(workStopping(deletionBegun(), [run, build]), 'run-1', []);
    expect(namedWork(unnamed, () => 'Tree run: a tree that is gone', named).work.map((item) => [item.what, item.state])).toEqual([['Tree run: Grow the tree', 'stopped'], ['Building a project', 'stopping']]);
    expect(namedWork(named, () => 'x').seq).toBe(named.seq);
  });
});
