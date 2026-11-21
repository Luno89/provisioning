import { describe, expect, it, vi } from 'vitest';
import { reopening, type Reopening } from '@koala/engine-core/reopening';
import { mock } from 'vitest-mock-extended';
import type { ProvisioningView, ProvisionReport, ProvisionTarget } from '@koala/engine-core/koala-install';
import { MemoryInfrastructureStore } from '../testing/memory-store.js';
import { openedRecord, pieceHeard, provisionWorkflowId, setUpProgress, type ProvisioningRecord, type ProvisionRunInput } from '../lib/provisioning.js';
import { ProvisionAsks, Provisioning, type ProvisionRoot, type ProvisionRuns } from './Provisioning.js';

const KOALA: ProvisionTarget = { kind: 'koala', clusterId: 'machine-desk' };
const LAB: ProvisionTarget = { kind: 'machine', clusterId: 'machine-lab', machine: 'lab', deviceId: 'device-lab' };

function setUp(given: { revision?: number; tellAgain?: Reopening } = {}) {
  const store = new MemoryInfrastructureStore();
  const started: ProvisionRunInput[] = [];
  const endings = new Map<string, (why: string) => void>();
  const runs = mock<ProvisionRuns>();
  runs.start.mockImplementation(async (input) => { started.push(input); return provisionWorkflowId(input.target.clusterId); });
  runs.ended.mockImplementation((workflowId) => new Promise<string>((resolve) => { endings.set(workflowId, resolve); }));
  const told: { ownerId: string; view: ProvisioningView }[] = [];
  const toldWaits: { until: (view: ProvisioningView) => boolean; done: () => void }[] = [];
  const toldWhen = (until: (view: ProvisioningView) => boolean) => (told.some((entry) => until(entry.view))
    ? Promise.resolve()
    : new Promise<void>((done) => { toldWaits.push({ until, done }); }));
  const reported: ProvisionReport[] = [];
  const root = mock<ProvisionRoot>();
  const hearing: { count: number; done: () => void }[] = [];
  root.setup.mockImplementation(async (report) => {
    reported.push(report);
    for (const wait of hearing.filter((entry) => reported.length >= entry.count)) { hearing.splice(hearing.indexOf(wait), 1); wait.done(); }
    return { ok: true };
  });
  const rootHeard = (count: number) => (reported.length >= count ? Promise.resolve() : new Promise<void>((done) => { hearing.push({ count, done }); }));
  const logged: string[] = [];
  let clock = Date.parse('2026-11-18T10:00:00.000Z');
  const provisioning = new Provisioning({
    store,
    runs,
    root,
    koala: { ownerId: 'owner-1', clusterId: KOALA.clusterId, revision: given.revision ?? 4 },
    changed: (ownerId, view) => {
      told.push({ ownerId, view });
      for (const wait of toldWaits.filter((entry) => entry.until(view))) { toldWaits.splice(toldWaits.indexOf(wait), 1); wait.done(); }
    },
    log: (line) => { logged.push(line); },
    now: () => new Date(clock += 1000),
    ...(given.tellAgain ? { tellAgain: given.tellAgain } : {}),
  });
  const end = (workflowId: string, why: string) => {
    const ending = endings.get(workflowId);
    if (!ending) throw new Error(`nothing follows ${workflowId}`);
    ending(why);
  };
  const followed = (workflowId: string) => endings.has(workflowId);
  return { store, runs, started, told, toldWhen, reported, rootHeard, root, logged, provisioning, end, followed };
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

  it('starts a run Koala stopped beside before naming its workflow, so one whose start is still under way elsewhere is joined, never failed', async () => {
    const { provisioning, store, runs, followed } = setUp({ revision: 4 });
    await store.openProvisioning(earlier(KOALA, 4, 'a'));
    await store.openProvisioning(earlier(LAB, 4, 'b'));
    await provisioning.start();

    expect(runs.start).toHaveBeenCalledWith({ ownerId: 'owner-1', recordId: 'provision-machine-desk~a', target: KOALA, revision: 4, reason: 'revision' });
    expect(runs.start).toHaveBeenCalledWith({ ownerId: 'owner-1', recordId: 'provision-machine-lab~b', target: LAB, revision: 4, reason: 'revision' });
    expect(await store.getProvisioningRun('provision-machine-desk~a')).toMatchObject({ state: 'running', workflowId: 'provision-machine-desk' });
    expect(await store.getProvisioningRun('provision-machine-lab~b')).toMatchObject({ state: 'running', workflowId: 'provision-machine-lab' });
    expect(followed('provision-machine-desk')).toBe(true);
    expect(followed('provision-machine-lab')).toBe(true);
    await provisioning.close();
  });

  it('fails a run Koala stopped beside only when starting it is refused, saying why', async () => {
    const { provisioning, store, runs } = setUp({ revision: 4 });
    await store.openProvisioning(earlier(LAB, 4, 'b'));
    runs.start.mockRejectedValueOnce(new Error('There is no procedure called "provision".'));
    await provisioning.start();

    expect(await store.getProvisioningRun('provision-machine-lab~b')).toMatchObject({ state: 'failed', why: 'the setup could not start: There is no procedure called "provision".' });
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

  it('tells root each line of its own cluster\'s setup in order, and that it is set up, once', async () => {
    const { provisioning, store, reported, rootHeard } = setUp();
    await provisioning.start();
    const [opened] = await store.getProvisioning(KOALA.clusterId);
    let record = opened!;
    for (const [at, change] of [[1, { state: 'started', line: 'deployment/egress-proxy: 0 of 1 ready' }], [2, { state: 'done' }]] as const) {
      record = pieceHeard(record, { stage: 'egress', title: 'The egress proxy', ...change }, '2026-11-18T10:00:30.000Z');
      await store.patchProvisioning(record.id, { pieces: record.pieces });
      await rootHeard(at);
    }
    const up = pieceHeard({ ...record, pieces: upPieces(record) }, setUpProgress(), '2026-11-18T10:09:00.000Z');
    await store.patchProvisioning(record.id, { pieces: up.pieces, state: up.state, endedAt: up.endedAt! });
    await provisioning.settled(record.id);
    await provisioning.close();

    const said = reported.map((report) => `${report.revision} ${report.progress.stage} ${report.progress.state}${report.progress.line ? ` ${report.progress.line}` : ''}`);
    expect(said.slice(0, 2)).toEqual(['4 egress started deployment/egress-proxy: 0 of 1 ready', '4 egress done']);
    expect(said.slice(2)).toEqual([...record.pieces.slice(1).map((piece) => `4 ${piece.key} done`), '4 set-up done']);
  });

  it('tells root where a run stopped when it ended without a piece failing, and nothing of another machine\'s collector', async () => {
    const { provisioning, store, reported, end } = setUp();
    await provisioning.ensure(LAB, 'missing');
    await provisioning.start();
    const [opened] = await store.getProvisioning(KOALA.clusterId);
    const settled = provisioning.settled(opened!.id);
    end('provision-machine-desk', 'the setup\'s run was stopped');
    await settled;
    await provisioning.close();

    expect(reported).toEqual([{ revision: 4, progress: { stage: 'egress', title: 'The egress proxy', state: 'failed', why: 'the setup\'s run was stopped' } }]);
  });

  it('tells root again on a restart how the setup it runs stands, and keeps on the setup, for its card, that root refused hearing how it ended', async () => {
    const { provisioning, store, reported, root, told, toldWhen } = setUp({ revision: 4 });
    await store.openProvisioning(earlier(KOALA, 4, 'a', { workflowId: 'provision-machine-desk' }));
    await store.patchProvisioning('provision-machine-desk~a', { state: 'up', pieces: upPieces(earlier(KOALA, 4, 'a')), endedAt: '2026-11-17T09:30:00.000Z' });
    root.setup.mockImplementation(async (report) => {
      reported.push(report);
      return report.progress.stage === 'set-up' ? { ok: false, status: 409, error: 'this Koala is moving' } : { ok: true };
    });
    await provisioning.start();
    await toldWhen((view) => view.root !== undefined);
    await provisioning.close();

    expect(reported.map((report) => report.progress.stage)).toEqual(['egress', 'searxng', 'crawl4ai', 'quickwit', 'qdrant', 'tei', 'gitea', 'verdaccio', 'infisical', 'monitoring', 'set-up']);
    const refused = { why: 'root refused hearing that Koala is set up: this Koala is moving (409)', at: expect.any(String) as unknown };
    expect((await store.getProvisioningRun('provision-machine-desk~a'))?.root).toEqual(refused);
    expect(told.at(-1)?.view).toMatchObject({ id: 'provision-machine-desk~a', root: refused });
  });

  it('drops a refusal from the setup once root takes a later line of it', async () => {
    const { provisioning, store, reported, root } = setUp({ revision: 4 });
    await store.openProvisioning(earlier(KOALA, 4, 'a', { workflowId: 'provision-machine-desk' }));
    await store.patchProvisioning('provision-machine-desk~a', { state: 'up', pieces: upPieces(earlier(KOALA, 4, 'a')), endedAt: '2026-11-17T09:30:00.000Z', root: { why: 'root refused hearing that Monitoring is up: no (400)', at: '2026-11-17T09:31:00.000Z' } });
    root.setup.mockImplementation(async (report) => {
      reported.push(report);
      return report.progress.stage === 'egress' ? { ok: false, status: 409, error: 'this Koala is moving' } : { ok: true };
    });
    await provisioning.start();
    await provisioning.close();

    expect(reported).toHaveLength(11);
    expect((await store.getProvisioningRun('provision-machine-desk~a'))?.root).toBeUndefined();
  });

  it('keeps on the setup that root could not be told, and tells root those lines with the next change', async () => {
    const { provisioning, store, reported, root, toldWhen } = setUp({ revision: 4 });
    let broken = true;
    root.setup.mockImplementation(async (report) => {
      if (broken) throw new Error('unable to verify the first certificate');
      reported.push(report);
      return { ok: true };
    });
    await provisioning.start();
    const [opened] = await store.getProvisioning(KOALA.clusterId);
    const started = pieceHeard(opened!, { stage: 'egress', title: 'The egress proxy', state: 'started', line: 'deployment/egress-proxy: 0 of 1 ready' }, '2026-11-18T10:00:30.000Z');
    await store.patchProvisioning(opened!.id, { pieces: started.pieces });
    await toldWhen((view) => view.id === opened!.id && view.root !== undefined);
    expect((await store.getProvisioningRun(opened!.id))?.root?.why).toBe('root could not be told that The egress proxy is under way: unable to verify the first certificate');
    expect(reported).toEqual([]);

    broken = false;
    const done = pieceHeard(started, { stage: 'egress', title: 'The egress proxy', state: 'done' }, '2026-11-18T10:01:00.000Z');
    await store.patchProvisioning(opened!.id, { pieces: done.pieces });
    await toldWhen((view) => view.id === opened!.id && view.root === undefined && view.pieces[0]?.state === 'up');
    await provisioning.close();

    expect(reported.map((report) => `${report.progress.stage} ${report.progress.state}`)).toEqual(['egress started', 'egress done']);
    expect((await store.getProvisioningRun(opened!.id))?.root).toBeUndefined();
  });

  it('shows on the card that its setup could not be read to tell root how it goes, and tells root once it can, though nothing changes after it', async () => {
    const { provisioning, store, reported, rootHeard, toldWhen } = setUp({ revision: 4, tellAgain: reopening(20) });
    await provisioning.start();
    const [opened] = await store.getProvisioning(KOALA.clusterId);
    const read = store.getProvisioningRun.bind(store);
    let broken = true;
    vi.spyOn(store, 'getProvisioningRun').mockImplementation(async (id) => {
      if (broken) throw new Error('connection 3 to mongo:27017 closed');
      return read(id);
    });
    const why = 'Koala could not read or write this setup to tell root how it goes: connection 3 to mongo:27017 closed';
    let shown = false;
    const cleared = toldWhen((view) => {
      if (view.root?.why === why) shown = true;
      return shown && view.root === undefined;
    });
    const started = pieceHeard(opened!, { stage: 'egress', title: 'The egress proxy', state: 'started', line: 'deployment/egress-proxy: 0 of 1 ready' }, '2026-11-18T10:00:30.000Z');
    await store.patchProvisioning(opened!.id, { pieces: started.pieces });
    await toldWhen((view) => view.id === opened!.id && view.pieces[0]?.state === 'working' && view.root?.why === why);
    expect(reported).toEqual([]);

    broken = false;
    await rootHeard(1);
    await cleared;
    await provisioning.close();
    expect(reported.map((report) => `${report.progress.stage} ${report.progress.state}`)).toEqual(['egress started']);
  });

  it('starts the run another process asked for by opening its record, once, while Koala is running', async () => {
    const { provisioning, store, runs, started, toldWhen } = setUp({ revision: 4 });
    await provisioning.start();
    const asks = new ProvisionAsks({ store, koala: { ownerId: 'owner-1', revision: 4 }, now: () => new Date('2026-11-18T11:00:00.000Z') });
    const named = new Promise<string>((done) => {
      const watching = store.watchProvisioning((record) => { if (record.target.clusterId === LAB.clusterId && record.workflowId) { void watching.close(); done(record.id); } });
    });
    const asked = await asks.ensure(LAB, 'missing');

    expect(await named).toBe(asked.id);
    await toldWhen((view) => view.id === asked.id && view.state === 'running');
    expect((await store.getProvisioningRun(asked.id))?.workflowId).toBe('provision-machine-lab');
    expect(started.filter((input) => input.recordId === asked.id)).toEqual([{ ownerId: 'owner-1', recordId: asked.id, target: LAB, revision: 4, reason: 'missing' }]);
    expect(runs.start).toHaveBeenCalledTimes(2);
    await provisioning.close();
  });
});

describe('asking Koala to set a cluster up from a process that starts no runs', () => {
  it('opens a run for a piece found missing, naming no workflow, and joins one already under way on that cluster', async () => {
    const store = new MemoryInfrastructureStore();
    const asks = new ProvisionAsks({ store, koala: { ownerId: 'owner-1', revision: 4 }, now: () => new Date('2026-11-18T11:00:00.000Z') });
    const opened = await asks.ensure(LAB, 'missing');
    expect(opened).toMatchObject({ target: LAB, revision: 4, reason: 'missing', state: 'running', ownerId: 'owner-1' });
    expect(opened.workflowId).toBeUndefined();
    expect(await store.getProvisioningRun(opened.id)).toEqual(opened);
    expect((await asks.ensure(LAB, 'missing')).id).toBe(opened.id);
    expect(await store.getProvisioning(LAB.clusterId)).toHaveLength(1);
  });

  it('waits until the run it asked for ends, and answers how', async () => {
    const store = new MemoryInfrastructureStore();
    const asks = new ProvisionAsks({ store, koala: { ownerId: 'owner-1', revision: 4 } });
    const opened = await asks.ensure(LAB, 'missing');
    const settled = asks.settled(opened.id);
    const failed = pieceHeard(opened, { stage: 'monitoring', title: 'lab\'s collector', state: 'failed', why: 'helm said no' }, '2026-11-18T11:02:00.000Z');
    await store.patchProvisioning(opened.id, { state: failed.state, pieces: failed.pieces, why: failed.why!, endedAt: failed.endedAt! });
    expect(await settled).toEqual({ state: 'failed', why: 'lab\'s collector: helm said no' });
  });
});
