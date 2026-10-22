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
import type { OdooRelease, SlotState } from '../../releases/lib/odoo-release.js';
import { CUT_OVER, CUT_OVER_LOSING, DISCARD, RETEST, type ReleaseRunInput, type RollBackRunInput } from '../../releases/lib/release-run.js';
import type { SchemaSnapshot } from '../../releases/lib/release-compare.js';
import { SNAPSHOT_SQL } from './postgres-compare.js';
import { platformCatalogue } from '../installed.js';
import type { SlotAdapter } from './adapter.js';
import { createReleaseOperations } from './operations/handlers.js';
import { REPLACE, SLOTS, SLOTS_ROLL_BACK } from './procedures.js';
import type { SlotCluster } from './slot-cluster.js';

const INPUT: ReleaseRunInput = {
  ownerId: 'bo', projectId: 'p1', adapter: 'fake',
  target: { clusterName: 'dev', provider: 'k3d', namespace: 'shop', release: 'shop' },
  host: 'shop.apps.local', previewHost: 'shop-preview.apps.local',
  secretTarget: { clusterName: 'dev', provider: 'k3d', isMock: false },
  build: { releaseId: 'r2', image: 'reg/shop:two', source: { owner: 'bo', repo: 'shop', commit: 'two' } },
};

const record = (id: string, extra: Partial<OdooRelease> = {}): OdooRelease => ({ id, ownerId: 'bo', projectId: 'p1', pipelineRunId: id, commit: id === 'r1' ? 'one' : 'two', image: `reg/shop:${id === 'r1' ? 'one' : 'two'}`, state: 'preparing', host: 'h', startedAt: id, updatedAt: id, ...extra });

interface Compared {
  live: SchemaSnapshot;
  prepared: SchemaSnapshot;
  counts: Record<string, number>[];
}

function world(over: { state: SlotState; records: OdooRelease[]; answers?: string[]; breakOn?: string; deploy?: { ok: true } | { ok: false; reason: string }; compared?: Compared }) {
  const compared = over.compared ?? { live: {}, prepared: {}, counts: [] };
  const counted = [...compared.counts];
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
    file: async () => null,
    apply: async (_target, source, sets) => {
      await act(`apply ${source.commit} ${sets.join(' ')}`);
      const [live, a, b] = sets.map((entry) => entry.split('=')[1]);
      state = { installed: true, live: live as 'a' | 'b', tags: { a: a === '-' ? undefined : a, b: b === '-' ? undefined : b } };
    },
    vault: async () => { await act('vault'); },
    waitReady: async (_target, workload) => { await act(`wait ${workload}`); },
    exec: async (_target, _pod, command) => {
      const sql = command.at(-1)!;
      const database = command[command.indexOf('-d') + 1];
      if (sql === SNAPSHOT_SQL) return JSON.stringify(database === `db_${state.live}` ? compared.live : compared.prepared);
      return JSON.stringify(counted.length > 1 ? counted.shift() : counted[0] ?? {});
    },
    job: async () => undefined,
    scale: async (_target, workload, replicas) => { await act(`scale ${workload} ${replicas}`); },
    put: async () => undefined,
    remove: async (_target, kind, name) => { await act(`remove ${kind} ${name}`); },
    running: async () => undefined,
    pipe: async () => '',
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
    database: (_t, slot) => ({ pod: 'db-0', user: 'app', database: `db_${slot}` }),
  };
  const operations = createReleaseOperations({
    cluster,
    adapters: { fake: adapter },
    releases: {
      list: async () => records.map((entry) => ({ ...entry })),
      save: async (saved) => { records = [...records.filter((entry) => entry.id !== saved.id), saved]; },
    },
    browserTests: async () => { actions.push('tests'); return { state: 'passed', summary: '1 passed', startedAt: 't0', finishedAt: 't1' }; },
    images: {
      deploy: async (projectId, pipelineRunId) => { actions.push(`deploy ${projectId} ${pipelineRunId}`); return { workflowId: 'app-deploy-1' }; },
      settled: async (workflowId) => { actions.push(`settled ${workflowId}`); return over.deploy ?? { ok: true }; },
    },
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
  const run = (procedure: Procedure, inputs: ReleaseRunInput | RollBackRunInput | Record<string, unknown>) => runProcedure({
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

  it('asks the person to confirm what a release would lose, records it, and cuts over only on that answer', async () => {
    const w = world({
      state: { installed: true, live: 'a', tags: { a: 'one', b: undefined } }, records: [record('r1', { state: 'live', slot: 'a' }), record('r2')], answers: [CUT_OVER_LOSING],
      compared: { live: { shop_order: { id: 'integer', note: 'text' } }, prepared: { shop_order: { id: 'integer' } }, counts: [{ 'columns|shop_order.note': 3 }] },
    });
    expect(await w.run(SLOTS, INPUT)).toMatchObject({ outcome: 'ok', reason: 'the release is live' });
    expect(w.asked.map((question) => question.choices)).toEqual([[CUT_OVER_LOSING, DISCARD, RETEST]]);
    expect(stateOf(w.records(), 'r2')).toMatchObject({ state: 'live', changes: { losing: true, columns: [{ table: 'shop_order', column: 'note', filled: 3 }] } });
  });

  it('stops the cut-over and serves the live slot again when the final copy would lose what the preview did not show', async () => {
    const w = world({
      state: { installed: true, live: 'a', tags: { a: 'one', b: undefined } }, records: [record('r1', { state: 'live', slot: 'a' }), record('r2')], answers: [CUT_OVER],
      compared: { live: { shop_order: { id: 'integer', note: 'text' } }, prepared: { shop_order: { id: 'integer' } }, counts: [{ 'columns|shop_order.note': 0 }, { 'columns|shop_order.note': 2 }] },
    });
    expect(await w.run(SLOTS, INPUT)).toMatchObject({ outcome: 'failed' });
    expect(w.asked.map((question) => question.choices)).toEqual([[CUT_OVER, DISCARD, RETEST]]);
    expect(w.actions.slice(-1)).toEqual(['scale app-a 1']);
    expect(stateOf(w.records(), 'r2')?.reason).toContain('the column shop_order.note is dropped; 2 rows held a value in it');
    expect(stateOf(w.records(), 'r2')).toMatchObject({ state: 'failed', changes: { losing: false } });
    expect(w.state().live).toBe('a');
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

describe('releasing by replacing the running app', () => {
  it('deploys the build\'s image and ends when the app answers', async () => {
    const w = world({ state: { installed: false, live: 'a', tags: { a: undefined, b: undefined } }, records: [] });
    expect(await w.run(REPLACE, { ownerId: 'bo', projectId: 'p1', pipelineRunId: 'b2' })).toMatchObject({ outcome: 'ok', reason: 'the build is deployed' });
    expect(w.actions).toEqual(['deploy p1 b2', 'settled app-deploy-1']);
  });

  it('fails with why when the app never comes up', async () => {
    const w = world({ state: { installed: false, live: 'a', tags: { a: undefined, b: undefined } }, records: [], deploy: { ok: false, reason: 'ImagePullBackOff: reg/api:def not found' } });
    expect(await w.run(REPLACE, { ownerId: 'bo', projectId: 'p1', pipelineRunId: 'b2' })).toMatchObject({ outcome: 'failed', reason: 'ImagePullBackOff: reg/api:def not found' });
  });
});
