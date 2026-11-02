import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { GroveRunStatus } from '../../infrastructure/index.js';
import type { Leaf } from '../lib/leaves.js';
import { GroveRunService, type GroveRunLauncher } from './GroveRunService.js';

const at = 'then';
const leaf = (over: Partial<Leaf> = {}): Leaf => ({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'L', status: 'pending', createdAt: at, updatedAt: at, ...over });

async function setUp(extra: { asking?: (runId: string) => Promise<string[]>; checkNeeds?: ConstructorParameters<typeof GroveRunService>[0]['checkNeeds'] } = {}) {
  const db = memoryDatabase();
  const launcher = mock<GroveRunLauncher>();
  const service = new GroveRunService({ store: db, launcher, now: () => 'stamped', ...extra });
  await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'mine', type: 'api-service', createdAt: at, updatedAt: at });
  await db.projects.saveTree({ id: 't2', ownerId: 'bo', name: 'theirs', type: 'api-service', createdAt: at, updatedAt: at });
  await db.projects.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'B', createdAt: at, updatedAt: at });
  return { db, launcher, service };
}

describe('a tree\'s run status', () => {
  it('is the launcher\'s, for the owner\'s tree only', async () => {
    const { launcher, service } = await setUp();
    launcher.groveRunStatus.calledWith('t1').mockResolvedValue({ state: 'none' });
    expect(await service.status('ann', 't1')).toEqual({ ok: true, value: { state: 'none' } });
    expect(await service.status('ann', 't2')).toEqual({ ok: false, status: 404, error: 'Tree not found' });
  });

  it('says which story waits for the person to allow a call, while its run still waits on it', async () => {
    const waiting = new Map([['g~1-leaf-1-executor-1', ['c1']]]);
    const { db, launcher, service } = await setUp({ asking: async (runId) => waiting.get(runId) ?? [] });
    const status: GroveRunStatus = { state: 'running', startedAt: 'then', turnId: 'g~1' };
    launcher.groveRunStatus.mockResolvedValue(status);
    await db.projects.saveLeaf(leaf({ runId: 'g~1-leaf-1' }));
    await db.engine.appendTurnLog({ turnId: 'g~1', ownerId: 'ann', seq: 1, at: 'now', events: [
      { type: 'run.started', runId: 'g~1-leaf-1', parentRunId: 'g~1', agentId: 'grove-leaf', loopId: 'l', at: 'now' },
      { type: 'run.started', runId: 'g~1-leaf-1-executor-1', parentRunId: 'g~1-leaf-1', agentId: 'executor', loopId: 'l', at: 'now' },
      { type: 'notice', runId: 'g~1-leaf-1-executor-1', level: 'warn', callId: 'c1', tool: 'delete_project', message: 'executor wants to run delete_project on this run: {}', at: 'now' },
      { type: 'notice', runId: 'g~1-leaf-1-executor-1', level: 'warn', callId: 'c0', tool: 'run_command', message: 'allowed already, still running', at: 'now' },
    ] as never });
    expect(await service.status('ann', 't1')).toEqual({
      ok: true,
      value: { ...status, asking: [{ runId: 'g~1-leaf-1-executor-1', callId: 'c1', tool: 'delete_project', message: 'executor wants to run delete_project on this run: {}', agent: 'executor', leafId: 'l1' }] },
    });
  });

  it('asks nobody when the tree is not running, and shows no asks that no run is waiting on any more', async () => {
    const asked: string[] = [];
    const { db, launcher, service } = await setUp({ asking: async (runId) => { asked.push(runId); return []; } });
    launcher.groveRunStatus.mockResolvedValueOnce({ state: 'none' });
    expect(await service.status('ann', 't1')).toEqual({ ok: true, value: { state: 'none' } });
    expect(asked).toEqual([]);

    const status: GroveRunStatus = { state: 'running', startedAt: 'then', turnId: 'g~2' };
    launcher.groveRunStatus.mockResolvedValue(status);
    await db.engine.appendTurnLog({ turnId: 'g~2', ownerId: 'ann', seq: 1, at: 'now', events: [
      { type: 'run.started', runId: 'g~2-executor', parentRunId: 'g~2', agentId: 'executor', loopId: 'l', at: 'now' },
      { type: 'notice', runId: 'g~2-executor', level: 'warn', callId: 'c1', tool: 'run_command', message: 'wants to run run_command', at: 'now' },
    ] as never });
    expect(await service.status('ann', 't1')).toEqual({ ok: true, value: status });
    expect(asked).toEqual(['g~2-executor']);
  });
});

describe('running a tree', () => {
  it('starts the run for a planned tree and answers the status', async () => {
    const { db, launcher, service } = await setUp();
    await db.projects.saveLeaf(leaf());
    launcher.startGroveRun.calledWith('ann', 't1').mockResolvedValue({ started: true, workflowId: 'grove-run-t1' });
    launcher.groveRunStatus.mockResolvedValue({ state: 'running', startedAt: 'then' });
    expect(await service.run('ann', 't1')).toEqual({ ok: true, value: { state: 'running', startedAt: 'then' } });
  });

  it('answers the status when a run is already going', async () => {
    const { db, launcher, service } = await setUp();
    await db.projects.saveLeaf(leaf());
    launcher.startGroveRun.mockResolvedValue({ started: false, reason: 'running' });
    launcher.groveRunStatus.mockResolvedValue({ state: 'running', startedAt: 'then' });
    expect(await service.run('ann', 't1')).toMatchObject({ ok: true, value: { state: 'running' } });
  });

  it('refuses an empty tree and another owner\'s without starting anything', async () => {
    const { launcher, service } = await setUp();
    expect(await service.run('ann', 't1')).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/Nothing is planned/) as unknown as string });
    expect(await service.run('ann', 't2')).toEqual({ ok: false, status: 404, error: 'Tree not found' });
    expect(launcher.startGroveRun).not.toHaveBeenCalled();
  });

  it('says so when Temporal cannot be reached or the tree\'s agent is switched off', async () => {
    const { db, launcher, service } = await setUp();
    await db.projects.saveLeaf(leaf());
    launcher.startGroveRun.mockResolvedValueOnce({ started: false, reason: 'unavailable' });
    expect(await service.run('ann', 't1')).toEqual({ ok: false, status: 503, error: 'Temporal is not reachable, so the tree cannot run.' });
    launcher.startGroveRun.mockResolvedValueOnce({ started: false, reason: 'switched-off' });
    expect(await service.run('ann', 't1')).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/switched off/) as unknown as string });
  });
});

describe('stopping a tree\'s run', () => {
  it('signals the run and answers the status', async () => {
    const { launcher, service } = await setUp();
    launcher.signalGroveRun.calledWith('t1', 'stopRun').mockResolvedValue(true);
    launcher.groveRunStatus.mockResolvedValue({ state: 'none' });
    expect(await service.stop('ann', 't1')).toEqual({ ok: true, value: { state: 'none' } });
  });

  it('says the tree is not running when there is no run to signal, and 404s another owner\'s', async () => {
    const { launcher, service } = await setUp();
    launcher.signalGroveRun.mockResolvedValue(false);
    expect(await service.stop('ann', 't1')).toEqual({ ok: false, status: 409, error: 'The tree is not running.' });
    expect(await service.stop('ann', 't2')).toEqual({ ok: false, status: 404, error: 'Tree not found' });
  });
});

describe('cancelling a story', () => {
  it('marks unfinished work cancelled and tells the tree\'s run', async () => {
    const { db, launcher, service } = await setUp();
    await db.projects.saveLeaf(leaf({ status: 'running' }));
    const outcome = await service.cancelLeaf('ann', leaf({ status: 'running' }));
    expect(outcome).toMatchObject({ ok: true, value: { id: 'l1', status: 'cancelled', updatedAt: 'stamped' } });
    expect((await db.projects.getLeaves())[0]?.status).toBe('cancelled');
    expect(launcher.signalGroveRun).toHaveBeenCalledWith('t1', 'cancelLeaf', 'l1');
  });

  it('refuses finished work', async () => {
    const { launcher, service } = await setUp();
    expect(await service.cancelLeaf('ann', leaf({ status: 'succeeded' }))).toEqual({ ok: false, status: 409, error: 'Only unfinished work can be cancelled; this leaf is succeeded.' });
    expect(launcher.signalGroveRun).not.toHaveBeenCalled();
  });

  it('signals no run for a story that belongs to no tree', async () => {
    const { launcher, service } = await setUp();
    await service.cancelLeaf('ann', leaf({ branchId: 'missing' }));
    expect(launcher.signalGroveRun).not.toHaveBeenCalled();
  });
});

describe('settling a claimed story', () => {
  const claimed = leaf({ status: 'claimed', claim: { evidence: 'it works', at } });

  it('verifies it, keeping the person\'s note as the finding', async () => {
    const { db, service } = await setUp();
    await db.projects.saveLeaf(claimed);
    const outcome = await service.settleClaim(claimed, 'verified', 'looks right');
    expect(outcome).toMatchObject({ ok: true, value: { status: 'succeeded', verified: true, findings: 'looks right', review: { verdict: 'sound', reason: 'looks right' } } });
    expect((await db.projects.getLeaves())[0]?.status).toBe('succeeded');
  });

  it('fails it only with a reason, and refuses a story nothing is claimed on', async () => {
    const { db, service } = await setUp();
    await db.projects.saveLeaf(claimed);
    expect(await service.settleClaim(claimed, 'failed', undefined)).toMatchObject({ ok: false, status: 409 });
    expect(await service.settleClaim(claimed, 'failed', 'missing the tests')).toMatchObject({ ok: true, value: { status: 'failed', findings: 'missing the tests' } });
    expect(await service.settleClaim(leaf(), 'verified', undefined)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/not awaiting judgment/) as unknown as string });
  });
});

describe('retrying a failed story', () => {
  const failed = leaf({ status: 'failed', findings: 'it broke' });

  async function failedSetUp(extra: Parameters<typeof setUp>[0] = {}) {
    const made = await setUp(extra);
    await made.db.projects.saveLeaf(failed);
    await made.db.projects.saveTask({ id: 'k1', ownerId: 'ann', leafId: 'l1', title: 'T', doneMeans: 'd', dependsOn: [], status: 'failed', runs: [], createdAt: at, updatedAt: at });
    await made.db.projects.saveTask({ id: 'k2', ownerId: 'ann', leafId: 'l1', title: 'T', doneMeans: 'd', dependsOn: [], status: 'done', runs: [], createdAt: at, updatedAt: at });
    made.launcher.startGroveRun.mockResolvedValue({ started: true, workflowId: 'grove-run-t1' });
    return made;
  }

  it('resets the story and its failed tasks and starts the tree\'s run', async () => {
    const { db, launcher, service } = await failedSetUp();
    const outcome = await service.retryLeaf('ann', failed);
    expect(outcome).toMatchObject({ ok: true, value: { status: 'pending', verified: false, attempts: [{ attempt: 1, error: 'it broke' }] } });
    expect((await db.projects.getLeaves())[0]?.status).toBe('pending');
    expect((await db.projects.getTasks('ann')).map((task) => [task.id, task.status])).toEqual([['k1', 'accepted'], ['k2', 'done']]);
    expect(launcher.startGroveRun).toHaveBeenCalledWith('ann', 't1');
  });

  it('refuses a story that has not failed, or belongs to no tree', async () => {
    const { launcher, service } = await failedSetUp();
    expect(await service.retryLeaf('ann', leaf({ status: 'running' }))).toEqual({ ok: false, status: 409, error: 'Only a failed leaf can be retried; this one is running.' });
    expect(await service.retryLeaf('ann', leaf({ status: 'failed', branchId: 'missing' }))).toEqual({ ok: false, status: 409, error: 'This leaf belongs to no tree, so there is nothing to run it in.' });
    expect(launcher.startGroveRun).not.toHaveBeenCalled();
  });

  it('says the story is reset but the tree cannot run when Temporal or the agent is unavailable', async () => {
    const { launcher, service } = await failedSetUp();
    launcher.startGroveRun.mockResolvedValueOnce({ started: false, reason: 'unavailable' });
    expect(await service.retryLeaf('ann', failed)).toEqual({ ok: false, status: 503, error: 'The leaf is reset, but Temporal is not reachable to run the tree.' });
    launcher.startGroveRun.mockResolvedValueOnce({ started: false, reason: 'switched-off' });
    expect(await service.retryLeaf('ann', failed)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/^The leaf is reset, but the agent that grows this tree/) as unknown as string });
  });

  it('asks what the story\'s tasks need of the workspace, and starts no run when that is refused', async () => {
    const asked: unknown[] = [];
    const { launcher, service } = await failedSetUp({ checkNeeds: async (ownerId, treeId, taskIds) => { asked.push([ownerId, treeId, taskIds]); return { refused: 'no such package' }; } });
    expect(await service.retryLeaf('ann', failed)).toEqual({ ok: false, status: 409, error: 'The leaf is reset, but its workspace could not be given what its checks need: no such package' });
    expect(asked).toEqual([['ann', 't1', ['k1', 'k2']]]);
    expect(launcher.startGroveRun).not.toHaveBeenCalled();
  });

  it('starts no run for a story the workspace parked, answering it as the store now has it', async () => {
    const parking: { park?: () => Promise<void> } = {};
    const { db, launcher, service } = await failedSetUp({ checkNeeds: async () => { await parking.park?.(); return { parked: ['l1'] }; } });
    parking.park = () => db.projects.saveLeaf({ ...failed, status: 'pending', waitingFor: { reason: 'a package', since: at } });
    const outcome = await service.retryLeaf('ann', failed);
    expect(outcome).toMatchObject({ ok: true, value: { id: 'l1', waitingFor: { reason: 'a package' } } });
    expect(launcher.startGroveRun).not.toHaveBeenCalled();
  });
});
