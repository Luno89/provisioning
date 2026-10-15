import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_GROUPS,
  HOST_OP_KIND,
  WORKFLOW_IMPLEMENTATIONS,
  createOrchestrationNodes,
  runProcedure,
  type NodeExecutor,
  type NodeImplementation,
  type Procedure,
  type QuestionRequest,
} from '@koala/agent-engine/procedure';
import type { OdooRelease, SlotState } from '../../lib/odoo-release.js';
import { CUT_OVER, DISCARD, RETEST, type ReleaseRunInput, type RollBackRunInput } from '../../lib/release-run.js';
import { platformCatalogue } from '../installed.js';
import type { SlotAdapter } from './adapter.js';
import { createReleaseOperations } from './operations/handlers.js';
import { SLOTS, SLOTS_ROLL_BACK } from './procedures.js';
import type { SlotCluster } from './slot-cluster.js';

const INPUT: ReleaseRunInput = {
  ownerId: 'bo', projectId: 'p1', adapter: 'fake',
  target: { clusterName: 'dev', provider: 'k3d', namespace: 'shop', release: 'shop' },
  host: 'shop.apps.local', previewHost: 'shop-preview.apps.local',
  secretTarget: { clusterName: 'dev', provider: 'k3d', isMock: false },
  build: { releaseId: 'r2', image: 'reg/shop:two', source: { owner: 'bo', repo: 'shop', commit: 'two' } },
};

const record = (id: string, extra: Partial<OdooRelease> = {}): OdooRelease => ({ id, ownerId: 'bo', projectId: 'p1', pipelineRunId: id, commit: id === 'r1' ? 'one' : 'two', image: `reg/shop:${id === 'r1' ? 'one' : 'two'}`, state: 'preparing', host: 'h', startedAt: id, updatedAt: id, ...extra });

function world(over: { state: SlotState; records: OdooRelease[]; answers?: string[]; breakOn?: string }) {
  let state = over.state;
  let records = over.records;
  const actions: string[] = [];
  const asked: QuestionRequest[] = [];
  const answers = [...(over.answers ?? [])];
  const act = async (what: string) => {
    actions.push(what);
    if (over.breakOn && what.startsWith(over.breakOn)) throw new Error(`${what} broke`);
  };
  const cluster = {
    state: async () => state,
    files: async () => [],
    apply: async (_target, source, sets) => {
      await act(`apply ${source.commit} ${sets.join(' ')}`);
      const [live, a, b] = sets.map((entry) => entry.split('=')[1]);
      state = { installed: true, live: live as 'a' | 'b', tags: { a: a === '-' ? undefined : a, b: b === '-' ? undefined : b } };
    },
    vault: async () => { await act('vault'); },
    waitReady: async (_target, workload) => { await act(`wait ${workload}`); },
    exec: async () => '',
    job: async () => undefined,
    scale: async (_target, workload, replicas) => { await act(`scale ${workload} ${replicas}`); },
  } as SlotCluster;
  const adapter: SlotAdapter = {
    id: 'fake', title: 'Fake',
    workload: (_target, slot) => `app-${slot}`,
    dataStore: () => 'data',
    sets: ({ state: slots, previewHost }) => [`live=${slots.live}`, `a=${slots.tags.a ?? '-'}`, `b=${slots.tags.b ?? '-'}`, ...(previewHost ? ['preview'] : [])],
    init: async (_c, _t, slot) => { await act(`init ${slot}`); },
    copy: async (_c, _t, from, to) => { await act(`copy ${from}->${to}`); },
    quiet: async (_c, _t, slot) => { await act(`quiet ${slot}`); },
    upgrade: async (_c, _t, slot) => { await act(`upgrade ${slot}`); },
  };
  const operations = createReleaseOperations({
    cluster,
    adapters: { fake: adapter },
    releases: {
      list: async () => records.map((entry) => ({ ...entry })),
      save: async (saved) => { records = [...records.filter((entry) => entry.id !== saved.id), saved]; },
    },
    browserTests: async () => { actions.push('tests'); return { state: 'passed', summary: '1 passed', startedAt: 't0', finishedAt: 't1' }; },
    now: () => '2026-10-15T00:00:00Z',
  });
  const local = new Map<string, NodeImplementation>([
    ...WORKFLOW_IMPLEMENTATIONS.map((implementation) => [implementation.kind, implementation] as const),
    ...createOrchestrationNodes({
      runTool: async () => { throw new Error('no tools here'); },
      runChild: async () => { throw new Error('no children here'); },
      approve: async () => false,
      ask: async (request) => {
        asked.push(request);
        const answer = answers.shift();
        return answer ? { answered: true, value: answer } : { answered: false, reason: 'the run was stopped' };
      },
    }).map((implementation) => [implementation.kind, implementation] as const),
  ]);
  const executor: NodeExecutor = {
    async step(request) {
      if (request.node.kind === HOST_OP_KIND) return operations[String(request.node.settings.operation)]!(request);
      const implementation = local.get(request.node.kind);
      if (implementation?.role !== 'step') throw new Error(`no step for ${request.node.kind}`);
      return implementation.run(request) as never;
    },
    async value(request) {
      const implementation = local.get(request.node.kind);
      if (implementation?.role !== 'value') throw new Error(`no value for ${request.node.kind}`);
      return implementation.run(request) as never;
    },
  };
  const run = (procedure: Procedure, inputs: ReleaseRunInput | RollBackRunInput) => runProcedure({
    procedure,
    catalogue: platformCatalogue(),
    groups: BUILT_IN_GROUPS,
    executor,
    identity: { runId: 'release-p1~1', depth: 0, agentId: 'release', loopId: procedure.id, loopVersion: '1', trigger: 'user' },
    launch: { ownerId: 'bo' },
    inputs: inputs as unknown as Record<string, unknown>,
    bus: { emit: () => undefined, subscribe: () => () => undefined } as never,
  });
  return { run, actions, asked, records: () => records, state: () => state };
}

const stateOf = (records: OdooRelease[], id: string) => records.find((entry) => entry.id === id);

describe('releasing beside the live slot', () => {
  it('puts the first release into slot a and makes it live', async () => {
    const w = world({ state: { installed: false, live: 'a', tags: { a: undefined, b: undefined } }, records: [record('r2')] });
    expect(await w.run(SLOTS, INPUT)).toMatchObject({ outcome: 'ok', reason: 'the first release is live in slot a' });
    expect(w.actions).toEqual(['apply two live=a a=- b=-', 'wait data', 'init a', 'apply two live=a a=two b=-', 'wait app-a']);
    expect(stateOf(w.records(), 'r2')).toMatchObject({ state: 'live', slot: 'a' });
  });

  it('prepares a later build beside the live one, tests it, asks the person, runs the tests again when asked, then cuts over', async () => {
    const w = world({ state: { installed: true, live: 'a', tags: { a: 'one', b: undefined } }, records: [record('r1', { state: 'live', slot: 'a' }), record('r2', { state: 'queued' })], answers: [RETEST, CUT_OVER] });
    expect(await w.run(SLOTS, INPUT)).toMatchObject({ outcome: 'ok', reason: 'the release is live' });
    expect(w.actions).toEqual([
      'apply two live=a a=one b=-', 'copy a->b', 'quiet b', 'upgrade b', 'apply two live=a a=one b=two preview', 'wait app-b',
      'tests', 'tests',
      'scale app-a 0', 'apply two live=a a=one b=-', 'copy a->b', 'upgrade b', 'apply two live=b a=one b=two', 'scale app-a 0', 'wait app-b',
    ]);
    expect(w.asked.map((question) => question.choices)).toEqual([[CUT_OVER, DISCARD, RETEST], [CUT_OVER, DISCARD, RETEST]]);
    expect(stateOf(w.records(), 'r2')).toMatchObject({ state: 'live', slot: 'b', e2e: { state: 'passed' } });
    expect(stateOf(w.records(), 'r1')).toMatchObject({ state: 'superseded', replacedBy: 'r2' });
    expect(w.state()).toEqual({ installed: true, live: 'b', tags: { a: 'one', b: 'two' } });
  });

  it('clears the preview when the person discards it, leaving the live slot as it was', async () => {
    const w = world({ state: { installed: true, live: 'a', tags: { a: 'one', b: undefined } }, records: [record('r1', { state: 'live', slot: 'a' }), record('r2')], answers: [DISCARD] });
    expect(await w.run(SLOTS, INPUT)).toMatchObject({ outcome: 'ok', reason: 'the person discarded the preview' });
    expect(w.actions.slice(-1)).toEqual(['apply two live=a a=one b=-']);
    expect(stateOf(w.records(), 'r2')).toMatchObject({ state: 'discarded' });
    expect(stateOf(w.records(), 'r1')).toMatchObject({ state: 'live' });
  });

  it('fails the release with why when it cannot be prepared, and never touches the live slot', async () => {
    const w = world({ state: { installed: true, live: 'a', tags: { a: 'one', b: undefined } }, records: [record('r1', { state: 'live', slot: 'a' }), record('r2')], breakOn: 'upgrade' });
    expect(await w.run(SLOTS, INPUT)).toMatchObject({ outcome: 'failed', reason: 'upgrade b broke' });
    expect(stateOf(w.records(), 'r2')).toMatchObject({ state: 'failed', reason: 'upgrade b broke' });
    expect(w.actions.some((action) => action.includes('app-a'))).toBe(false);
  });

  it('sets a waiting preview aside when the run is stopped instead of answered', async () => {
    const w = world({ state: { installed: true, live: 'a', tags: { a: 'one', b: undefined } }, records: [record('r1', { state: 'live', slot: 'a' }), record('r2')], answers: [] });
    expect(await w.run(SLOTS, INPUT)).toMatchObject({ outcome: 'failed', reason: 'the run was stopped' });
    expect(stateOf(w.records(), 'r2')).toMatchObject({ state: 'superseded', reason: 'a newer build took its place' });
    expect(w.state().tags.b).toBeUndefined();
  });
});

describe('rolling back', () => {
  it('starts the kept slot and makes the earlier release live again', async () => {
    const w = world({ state: { installed: true, live: 'b', tags: { a: 'one', b: 'two' } }, records: [record('r1', { state: 'superseded', slot: 'a', replacedBy: 'r2' }), record('r2', { state: 'live', slot: 'b' })] });
    const back: RollBackRunInput = { ...INPUT, from: 'r2', to: { releaseId: 'r1', image: 'reg/shop:one', source: { owner: 'bo', repo: 'shop', commit: 'one' } } };
    expect(await w.run(SLOTS_ROLL_BACK, back)).toMatchObject({ outcome: 'ok', reason: 'the kept release is live again' });
    expect(stateOf(w.records(), 'r1')).toMatchObject({ state: 'live', slot: 'a' });
    expect(stateOf(w.records(), 'r2')).toMatchObject({ state: 'rolled-back' });
    expect(w.state()).toEqual({ installed: true, live: 'a', tags: { a: 'one', b: undefined } });
  });
});
