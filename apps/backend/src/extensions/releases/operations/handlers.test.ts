import { describe, it, expect, beforeEach } from 'vitest';
import type { NodeRequest } from '@koala/agent-engine/procedure';
import { createReleaseOperations, type BrowserTestsRequest } from './handlers.js';
import type { SlotAdapter } from '../adapter.js';
import type { SlotCluster } from '../slot-cluster.js';
import type { OdooRelease, SlotState } from '../../../lib/odoo-release.js';
import type { ReleaseE2E } from '../../../lib/release-e2e.js';
import type { ReleaseRunInput, RollBackRunInput } from '../../../lib/release-run.js';

let actions: string[];
let state: SlotState;
let records: OdooRelease[];
let breakOn: string | undefined;

const act = async (what: string) => {
  actions.push(what);
  if (breakOn && what.startsWith(breakOn)) throw new Error(`${what} broke`);
};

const cluster: SlotCluster = {
  state: async () => state,
  files: async () => [],
  file: async () => null,
  apply: async (_target, source, sets) => { await act(`apply ${source.commit} ${sets.join(' ')}`); },
  vault: async () => { await act('vault'); },
  waitReady: async (_target, workload) => { await act(`wait ${workload}`); },
  exec: async () => '{}',
  job: async () => undefined,
  scale: async (_target, workload, replicas) => { await act(`scale ${workload} ${replicas}`); },
} as SlotCluster;

const adapter: SlotAdapter = {
  id: 'fake',
  title: 'Fake',
  workload: (_target, slot) => `app-${slot}`,
  dataStore: () => 'data',
  sets: ({ state: slots, previewHost }) => [`live=${slots.live}`, `a=${slots.tags.a ?? '-'}`, `b=${slots.tags.b ?? '-'}`, ...(previewHost ? ['preview'] : [])],
  init: async (_c, _t, slot) => { await act(`init ${slot}`); },
  copy: async (_c, _t, from, to) => { await act(`copy ${from}->${to}`); },
  quiet: async (_c, _t, slot) => { await act(`quiet ${slot}`); },
  upgrade: async (_c, _t, slot) => { await act(`upgrade ${slot}`); },
  database: (_t, slot) => ({ pod: 'db-0', user: 'app', database: `db_${slot}` }),
};

const input: ReleaseRunInput = {
  ownerId: 'bo', projectId: 'p1', adapter: 'fake',
  target: { clusterName: 'dev', provider: 'k3d', namespace: 'shop', release: 'shop' },
  host: 'shop.apps.local', previewHost: 'shop-preview.apps.local',
  secretTarget: { clusterName: 'dev', provider: 'k3d', isMock: false },
  build: { releaseId: 'r2', image: 'reg/shop:two', source: { owner: 'bo', repo: 'shop', commit: 'two' } },
};

const release = (id: string, extra: Partial<OdooRelease> = {}): OdooRelease => ({ id, ownerId: 'bo', projectId: 'p1', pipelineRunId: id, commit: id === 'r1' ? 'one' : 'two', image: `reg/shop:${id === 'r1' ? 'one' : 'two'}`, state: 'preparing', host: 'h', startedAt: id, updatedAt: id, ...extra });

let tested: BrowserTestsRequest[];
const ops = (browser = true) => createReleaseOperations({
  cluster,
  adapters: { fake: adapter },
  releases: {
    list: async () => records.map((entry) => ({ ...entry })),
    save: async (saved) => { records = [...records.filter((entry) => entry.id !== saved.id), saved]; },
  },
  ...(browser ? { browserTests: async (request: BrowserTestsRequest): Promise<ReleaseE2E> => { tested.push(request); return { state: 'passed', summary: '1 passed', startedAt: 't0', finishedAt: 't1' }; } } : {}),
  now: () => '2026-10-15T00:00:00Z',
});

const request = (inputs: Record<string, unknown> = {}, settings: Record<string, unknown> = {}, runInputs: unknown = input) => ({
  inputs, node: { settings }, run: { inputs: runInputs },
}) as unknown as NodeRequest;

const stateOf = (id: string) => records.find((entry) => entry.id === id);

beforeEach(() => {
  actions = [];
  state = { installed: true, live: 'a', tags: { a: 'one', b: undefined } };
  records = [release('r1', { state: 'live', slot: 'a' }), release('r2', { state: 'queued' })];
  breakOn = undefined;
  tested = [];
});

describe('opening a release', () => {
  it('puts the first release into slot a, and every later one beside the live slot', async () => {
    expect(await ops()['releases.open']!(request())).toMatchObject({ exit: 'beside', outputs: { release: input } });
    expect(stateOf('r2')).toMatchObject({ state: 'preparing' });
    state = { installed: false, live: 'a', tags: { a: undefined, b: undefined } };
    expect(await ops()['releases.open']!(request())).toMatchObject({ exit: 'first' });
  });

  it('says when the release is gone', async () => {
    records = [];
    expect(await ops()['releases.open']!(request())).toEqual({ exit: 'gone', outputs: { reason: 'the release is no longer recorded' } });
  });
});

describe('preparing beside the live slot', () => {
  it('clears the idle slot, copies the live data in, quiets and upgrades it, then starts it on the preview address', async () => {
    expect(await ops()['releases.prepare']!(request({ release: input }))).toMatchObject({ exit: 'ready', outputs: { release: { slot: 'b' } } });
    expect(actions).toEqual(['apply two live=a a=one b=-', 'copy a->b', 'quiet b', 'upgrade b', 'apply two live=a a=one b=two preview', 'wait app-b']);
    expect(stateOf('r2')).toMatchObject({ state: 'preparing', slot: 'b' });
  });

  it('fails with the reason and leaves the live slot alone', async () => {
    breakOn = 'upgrade';
    expect(await ops()['releases.prepare']!(request({ release: input }))).toEqual({ exit: 'failed', outputs: { reason: 'upgrade b broke' } });
    expect(actions.some((action) => action.startsWith('scale'))).toBe(false);
  });
});

describe('the preview\'s browser tests', () => {
  it('keeps what the tests found on the release, as running and then as they ended', async () => {
    const result = await ops()['releases.browser-tests']!(request({ release: { ...input, slot: 'b' } }));
    expect(result).toEqual({ exit: 'done', outputs: { report: { state: 'passed', summary: '1 passed', startedAt: 't0', finishedAt: 't1' } } });
    expect(tested).toEqual([{ target: input.target, source: input.build.source, ownerId: 'bo', releaseId: 'r2', slot: 'b', image: 'reg/shop:two' }]);
    expect(stateOf('r2')).toMatchObject({ state: 'preview', e2e: { state: 'passed' } });
  });

  it('records that they could not run on a worker without them, and goes on', async () => {
    expect(await ops(false)['releases.browser-tests']!(request({ release: { ...input, slot: 'b' } }))).toMatchObject({ exit: 'done' });
    expect(stateOf('r2')).toMatchObject({ state: 'preview', e2e: { state: 'unavailable', reason: 'browser tests are not set up on this worker' } });
  });
});

describe('cutting over', () => {
  it('puts the live slot in maintenance, copies and upgrades again, switches live and stops the old slot', async () => {
    state = { installed: true, live: 'a', tags: { a: 'one', b: 'two' } };
    expect(await ops()['releases.switch']!(request({ release: { ...input, slot: 'b' } }))).toMatchObject({ exit: 'done' });
    expect(actions).toEqual(['scale app-a 0', 'apply two live=a a=one b=-', 'copy a->b', 'upgrade b', 'apply two live=b a=one b=two', 'scale app-a 0', 'wait app-b']);
  });

  it('starts the old slot again when the cut-over breaks before live switched', async () => {
    breakOn = 'upgrade';
    expect(await ops()['releases.switch']!(request({ release: { ...input, slot: 'b' } }))).toEqual({ exit: 'failed', outputs: { reason: 'upgrade b broke' } });
    expect(actions.at(-1)).toBe('scale app-a 1');
  });
});

describe('marking a release', () => {
  it('records live and sets the one it replaced aside as the way back', async () => {
    await ops()['releases.mark']!(request({ release: { ...input, slot: 'b' } }, { state: 'live' }));
    expect(stateOf('r2')).toMatchObject({ state: 'live', slot: 'b', liveAt: '2026-10-15T00:00:00Z' });
    expect(stateOf('r1')).toMatchObject({ state: 'superseded', replacedBy: 'r2', reason: 'replaced by the release of two' });
  });

  it('records a failure with its reason, and refuses a state it does not mark', async () => {
    await ops()['releases.mark']!(request({ release: input, reason: 'it broke' }, { state: 'failed' }));
    expect(stateOf('r2')).toMatchObject({ state: 'failed', reason: 'it broke' });
    await expect(ops()['releases.mark']!(request({ release: input }, { state: 'rolling-back' }))).rejects.toThrow('cannot mark a release rolling-back');
  });
});

describe('a stopped release', () => {
  it('clears a waiting preview and sets it aside for the newer build', async () => {
    records = [release('r1', { state: 'live', slot: 'a' }), release('r2', { state: 'preview', slot: 'b' })];
    state = { installed: true, live: 'a', tags: { a: 'one', b: 'two' } };
    await ops()['releases.stopped']!(request());
    expect(actions).toEqual(['apply two live=a a=one b=-']);
    expect(stateOf('r2')).toMatchObject({ state: 'superseded', reason: 'a newer build took its place' });
  });

  it('marks one stopped mid cut-over failed and starts the live slot again, and leaves a settled one alone', async () => {
    records = [release('r1', { state: 'live', slot: 'a' }), release('r2', { state: 'cutting-over', slot: 'b' })];
    await ops()['releases.stopped']!(request());
    expect(actions).toEqual(['scale app-a 1']);
    expect(stateOf('r2')).toMatchObject({ state: 'failed' });
    actions = [];
    await ops()['releases.stopped']!(request());
    expect(actions).toEqual([]);
  });
});

describe('rolling back', () => {
  const back: RollBackRunInput = { ...input, from: 'r2', to: { releaseId: 'r1', image: 'reg/shop:one', source: { owner: 'bo', repo: 'shop', commit: 'one' } } };

  it('starts the kept slot, makes it live, and records the earlier release live again and the later one rolled back', async () => {
    records = [release('r1', { state: 'superseded', slot: 'a', replacedBy: 'r2', reason: 'replaced' }), release('r2', { state: 'live', slot: 'b' })];
    state = { installed: true, live: 'b', tags: { a: 'one', b: 'two' } };
    expect(await ops()['releases.roll-back']!(request({}, {}, back))).toEqual({ exit: 'done', outputs: {} });
    expect(actions).toEqual(['scale app-a 1', 'wait app-a', 'apply one live=a a=one b=-', 'wait app-a']);
    expect(stateOf('r1')).toMatchObject({ state: 'live', slot: 'a', restoredAt: '2026-10-15T00:00:00Z' });
    expect(stateOf('r1')).not.toHaveProperty('replacedBy');
    expect(stateOf('r2')).toMatchObject({ state: 'rolled-back', reason: 'rolled back to the release of one' });
  });

  it('stops the kept slot again when it never comes up, and keeps the current one live', async () => {
    records = [release('r1', { state: 'superseded', slot: 'a' }), release('r2', { state: 'live', slot: 'b' })];
    state = { installed: true, live: 'b', tags: { a: 'one', b: 'two' } };
    breakOn = 'wait app-a';
    expect(await ops()['releases.roll-back']!(request({}, {}, back))).toEqual({ exit: 'failed', outputs: { reason: 'wait app-a broke' } });
    expect(actions).toEqual(['scale app-a 1', 'wait app-a', 'scale app-a 0']);
    expect(stateOf('r2')).toMatchObject({ state: 'live', reason: 'the rollback failed: wait app-a broke' });
  });

  it('refuses when the kept slot no longer holds that release, and keeps the current one live', async () => {
    records = [release('r1', { state: 'superseded', slot: 'a' }), release('r2', { state: 'live', slot: 'b' })];
    state = { installed: true, live: 'b', tags: { a: 'three', b: 'two' } };
    expect(await ops()['releases.roll-back']!(request({}, {}, back))).toEqual({ exit: 'failed', outputs: { reason: 'slot a no longer holds the release of one' } });
    expect(stateOf('r2')).toMatchObject({ state: 'live', reason: 'the rollback failed: slot a no longer holds the release of one' });
  });
});
