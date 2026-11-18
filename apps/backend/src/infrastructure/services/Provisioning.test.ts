import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ProvisioningView, ProvisionTarget } from '@koala/engine-core/koala-install';
import { MemoryInfrastructureStore } from '../testing/memory-store.js';
import { openedRecord, pieceHeard, provisionWorkflowId, setUpProgress, type ProvisioningRecord, type ProvisionRunInput } from '../lib/provisioning.js';
import { Provisioning, type ProvisionRuns } from './Provisioning.js';

const KOALA: ProvisionTarget = { kind: 'koala', clusterId: 'machine-desk' };
const LAB: ProvisionTarget = { kind: 'machine', clusterId: 'machine-lab', machine: 'lab' };

function setUp(given: { revision?: number; inTemporal?: Record<string, string> } = {}) {
  const store = new MemoryInfrastructureStore();
  const started: ProvisionRunInput[] = [];
  const endings = new Map<string, (why: string) => void>();
  const runs = mock<ProvisionRuns>();
  runs.start.mockImplementation(async (input) => { started.push(input); return provisionWorkflowId(input.target.clusterId); });
  runs.started.mockImplementation(async (runId) => given.inTemporal?.[runId]);
  runs.ended.mockImplementation((workflowId) => new Promise<string>((resolve) => { endings.set(workflowId, resolve); }));
  const told: { ownerId: string; view: ProvisioningView }[] = [];
  let clock = Date.parse('2026-11-18T10:00:00.000Z');
  const provisioning = new Provisioning({
    store,
    runs,
    koala: { ownerId: 'owner-1', clusterId: KOALA.clusterId, revision: given.revision ?? 4 },
    changed: (ownerId, view) => { told.push({ ownerId, view }); },
    log: () => undefined,
    now: () => new Date(clock += 1000),
  });
  const end = (workflowId: string, why: string) => {
    const ending = endings.get(workflowId);
    if (!ending) throw new Error(`nothing follows ${workflowId}`);
    ending(why);
  };
  const followed = (workflowId: string) => endings.has(workflowId);
  return { store, runs, started, told, provisioning, end, followed };
}

const earlier = (target: ProvisionTarget, revision: number, stamp: string, over: Partial<ProvisioningRecord> = {}): ProvisioningRecord => ({
  ...openedRecord({ ownerId: 'owner-1', target, revision, reason: 'revision', runId: `provision-${target.clusterId}~${stamp}`, at: `2026-11-17T09:00:0${stamp.length}.000Z` }),
  ...over,
});

const upPieces = (record: ProvisioningRecord) => record.pieces.map((piece) => ({ ...piece, state: 'up' as const }));

describe('setting Koala up after its chart', () => {
  it('starts a run for a new chart revision when Koala starts, for its own cluster, and names the run\'s workflow on its record', async () => {
    const { provisioning, started, store } = setUp({ revision: 4 });
    await provisioning.start();

    const [record] = await store.getProvisioning(KOALA.clusterId);
    expect(started).toEqual([{ ownerId: 'owner-1', recordId: record!.id, target: KOALA, revision: 4, reason: 'revision' }]);
    expect(record).toMatchObject({ target: KOALA, revision: 4, reason: 'revision', state: 'running', workflowId: 'provision-machine-desk' });
    expect(record!.id).toMatch(/^provision-machine-desk~[0-9a-z]+$/);
    expect(record!.pieces.every((piece) => piece.state === 'waiting')).toBe(true);
    await provisioning.close();
  });

  it('starts nothing on a restart within a revision that was set up, or that failed, and waits for the person or the next revision', async () => {
    for (const state of ['up', 'failed'] as const) {
      const { provisioning, store, runs } = setUp({ revision: 4 });
      await store.openProvisioning(earlier(KOALA, 4, 'a', { workflowId: 'provision-machine-desk' }));
      await store.patchProvisioning('provision-machine-desk~a', { state, endedAt: '2026-11-17T09:30:00.000Z' });
      await provisioning.start();

      expect(runs.start).not.toHaveBeenCalled();
      expect(await store.getProvisioning(KOALA.clusterId)).toHaveLength(1);
      await provisioning.close();
    }
  });

  it('follows a run still under way when Koala restarts, rather than starting a second', async () => {
    const { provisioning, store, runs, followed } = setUp({ revision: 4 });
    await store.openProvisioning(earlier(KOALA, 4, 'a', { workflowId: 'provision-machine-desk' }));
    await provisioning.start();

    expect(runs.start).not.toHaveBeenCalled();
    expect(followed('provision-machine-desk')).toBe(true);
    await provisioning.close();
  });

  it('settles a run whose workflow ended without saying how its pieces ended as failed, with how it ended, the piece under way failed too', async () => {
    const { provisioning, store, end } = setUp();
    await provisioning.start();
    const [opened] = await store.getProvisioning(KOALA.clusterId);
    const working = pieceHeard(opened!, { stage: 'egress', title: 'The egress proxy', state: 'started', line: 'waiting for deployment/egress' }, '2026-11-18T10:00:30.000Z');
    await store.patchProvisioning(opened!.id, { pieces: working.pieces });

    const settled = provisioning.settled(opened!.id);
    end('provision-machine-desk', 'the setup\'s run was stopped');

    expect(await settled).toEqual({ state: 'failed', why: 'the setup\'s run was stopped' });
    const failed = await store.getProvisioningRun(opened!.id);
    expect(failed).toMatchObject({ state: 'failed', why: 'the setup\'s run was stopped' });
    expect(failed?.pieces.find((piece) => piece.key === 'egress')).toMatchObject({ state: 'failed', why: 'the setup\'s run was stopped' });
    await provisioning.close();
  });

  it('leaves a run that marked itself up as up when its workflow ends', async () => {
    const { provisioning, store, end } = setUp();
    await provisioning.start();
    const [opened] = await store.getProvisioning(KOALA.clusterId);
    const up = pieceHeard({ ...opened!, pieces: upPieces(opened!) }, setUpProgress(), '2026-11-18T10:09:00.000Z');
    await store.patchProvisioning(opened!.id, { pieces: up.pieces, state: up.state, endedAt: up.endedAt! });

    end('provision-machine-desk', 'the setup\'s run finished without saying how its pieces ended');

    expect(await provisioning.settled(opened!.id)).toEqual({ state: 'up' });
    expect(await store.getProvisioningRun(opened!.id)).toMatchObject({ state: 'up' });
    await provisioning.close();
  });

  it('fails a run that could not start, saying why, so the person sees it and can set Koala up again', async () => {
    const { provisioning, store, runs, told } = setUp();
    runs.start.mockRejectedValueOnce(new Error('Temporal is not reachable'));
    await provisioning.start();

    const [record] = await store.getProvisioning(KOALA.clusterId);
    expect(record).toMatchObject({ state: 'failed', why: 'the setup could not start: Temporal is not reachable' });
    expect(record).not.toHaveProperty('workflowId');
    expect(await provisioning.settled(record!.id)).toEqual({ state: 'failed', why: 'the setup could not start: Temporal is not reachable' });
    expect(told.at(-1)?.ownerId).toBe('owner-1');
    expect(told.at(-1)?.view).toMatchObject({ id: record!.id, state: 'failed' });
    await provisioning.close();
  });

  it('names the workflow of a run Koala stopped beside when Temporal has it, and fails one Temporal never started', async () => {
    const { provisioning, store, followed } = setUp({ revision: 4, inTemporal: { 'provision-machine-desk~a': 'provision-machine-desk' } });
    await store.openProvisioning(earlier(KOALA, 4, 'a'));
    await store.openProvisioning(earlier(LAB, 4, 'b'));
    await provisioning.start();

    expect(await store.getProvisioningRun('provision-machine-desk~a')).toMatchObject({ state: 'running', workflowId: 'provision-machine-desk' });
    expect(followed('provision-machine-desk')).toBe(true);
    expect(await store.getProvisioningRun('provision-machine-lab~b')).toMatchObject({ state: 'failed', why: 'Koala stopped before this setup\'s run started' });
    await provisioning.close();
  });

  it('starts a run for a piece found missing or the person\'s ask even after the revision\'s run failed, and joins one under way', async () => {
    const { provisioning, store, started } = setUp({ revision: 4 });
    await store.openProvisioning(earlier(KOALA, 4, 'a'));
    await store.patchProvisioning('provision-machine-desk~a', { state: 'failed', why: 'Gitea: it never started', endedAt: '2026-11-17T09:30:00.000Z' });

    const missing = await provisioning.ensure(KOALA, 'missing');
    expect(missing).toMatchObject({ reason: 'missing', revision: 4, state: 'running', workflowId: 'provision-machine-desk' });
    expect(await provisioning.ensure(KOALA, 'asked')).toEqual(missing);
    expect(started.map((input) => input.reason)).toEqual(['missing']);

    const collector = await provisioning.ensure(LAB, 'missing');
    expect(collector).toMatchObject({ target: LAB, pieces: [{ key: 'monitoring', title: 'lab\'s collector', state: 'waiting' }] });
    expect(started.map((input) => input.target)).toEqual([KOALA, LAB]);
    await provisioning.close();
  });

  it('starts one run when two ask at once', async () => {
    const { provisioning, started } = setUp();
    const [one, two] = await Promise.all([provisioning.ensure(KOALA, 'missing'), provisioning.ensure(KOALA, 'asked')]);
    expect(one.id).toBe(two.id);
    expect(started).toHaveLength(1);
    await provisioning.close();
  });

  it('sets up again the place a cluster\'s latest run was for, as the person asked, and knows no cluster it set nothing up on', async () => {
    const { provisioning, store, started } = setUp();
    await store.openProvisioning(earlier(LAB, 4, 'b'));
    await store.patchProvisioning('provision-machine-lab~b', { state: 'failed', why: 'lab\'s collector: no room', endedAt: '2026-11-17T09:30:00.000Z' });

    expect(await provisioning.again(LAB.clusterId)).toMatchObject({ target: LAB, reason: 'asked', state: 'running' });
    expect(started).toEqual([expect.objectContaining({ target: LAB, reason: 'asked' })]);
    expect(await provisioning.again('machine-nowhere')).toBeUndefined();
    await provisioning.close();
  });

  it('answers the latest run of each place, Koala\'s own first', async () => {
    const { provisioning, store } = setUp();
    await store.openProvisioning(earlier(LAB, 4, 'b'));
    await store.openProvisioning(earlier(KOALA, 3, 'a'));
    await store.patchProvisioning('provision-machine-desk~a', { state: 'up', endedAt: '2026-11-17T09:30:00.000Z' });
    await store.openProvisioning(earlier(KOALA, 4, 'cc'));

    expect((await provisioning.latest()).map((record) => record.id)).toEqual(['provision-machine-desk~cc', 'provision-machine-lab~b']);
  });

  it('tells the owner each time a run changes, as the card shows it', async () => {
    const { provisioning, store, told } = setUp();
    await provisioning.start();
    const [opened] = await store.getProvisioning(KOALA.clusterId);
    const settled = provisioning.settled(opened!.id);
    await store.patchProvisioning(opened!.id, { state: 'failed', why: 'Gitea: it never started', endedAt: '2026-11-18T10:05:00.000Z' }, true);
    await settled;

    expect(told.map(({ ownerId, view }) => `${ownerId} ${view.state} ${'workflowId' in view ? 'with ids' : 'without ids'}`)).toEqual(['owner-1 running without ids', 'owner-1 running without ids', 'owner-1 failed without ids']);
    await provisioning.close();
  });

  it('knows no run it does not have when asked to wait for one', async () => {
    const { provisioning } = setUp();
    await expect(provisioning.settled('provision-nowhere~x')).rejects.toThrow('there is no setup run provision-nowhere~x');
  });
});
