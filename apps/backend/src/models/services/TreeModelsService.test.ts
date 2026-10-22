import { describe, it, expect } from 'vitest';
import type { PlacedNode, Procedure } from '@koala/agent-engine/procedure';
import { MemoryDB } from '../../platform/lib/memory-db.js';
import { seedTreeTypes } from '../../projects/lib/tree-types.js';
import type { ModelProvider } from '../lib/model-registry.js';
import type { TreeAgent } from '../lib/tree-models.js';
import { TreeModelsService } from './TreeModelsService.js';

const node = (id: string, kind: string, settings: Record<string, unknown> = {}): PlacedNode =>
  ({ id, kind, settings, position: [0, 0] }) as unknown as PlacedNode;
const proc = (nodes: PlacedNode[]): Procedure => ({ id: 'p', name: 'p', describe: '', nodes, groups: [] }) as unknown as Procedure;

const agents: Record<string, TreeAgent> = {
  grove: { slug: 'grove', name: 'Grove', procedure: proc([node('work', 'fan-out', { agent: 'grove-leaf' }), node('judge', 'fan-out', { agent: 'leaf-judge' }), node('plan', 'fan-out', { agent: 'planner' })]) },
  'grove-leaf': { slug: 'grove-leaf', name: 'Grove leaf', procedure: proc([node('do', 'delegate', { agent: 'executor' })]) },
  executor: { slug: 'executor', name: 'Executor', describe: 'Does the tasks', endpointId: 'tabby', procedure: proc([node('where', 'where-it-runs'), node('m', 'call-model')]) },
  'leaf-judge': { slug: 'leaf-judge', name: 'Leaf judge', procedure: proc([node('m', 'choose-model'), node('c', 'call-model')]) },
  planner: { slug: 'planner', name: 'Planner', endpointId: 'machine:dev-1:gemini', procedure: proc([node('m', 'call-model')]) },
};

const providers = [{ id: 'tabby', name: 'Tabby' }, { id: 'vllm', name: 'vLLM' }] as ModelProvider[];

const setUp = async () => {
  const db = new MemoryDB();
  await seedTreeTypes(db);
  await db.saveTree({ id: 't1', ownerId: 'u1', name: 'shop', type: 'api-service', createdAt: 'x', updatedAt: 'x' } as never);
  const service = new TreeModelsService({
    store: db,
    models: {
      list: async () => providers,
      route: async (_owner, _model, endpointId) => {
        const provider = providers.find((entry) => entry.id === (endpointId ?? 'vllm'));
        if (!provider) throw new Error(`Model ${endpointId} not found`);
        return { provider };
      },
    },
    agentOf: async (_owner, slug) => agents[slug],
    machines: async (owner) => owner === 'u1' ? [{
      id: 'dev-1',
      name: 'OZ-001',
      online: false,
      agents: [
        { id: 'antigravity', title: 'Antigravity', state: 'ready' },
        { id: 'gemini', title: 'Gemini CLI', state: 'missing', reason: 'Google refuses personal sign-ins' },
      ],
    }] as never : [],
    now: () => 'now',
  });
  return { db, service };
};

describe('the models a tree works with', () => {
  it('lists each agent in its work that asks a model, with what it would use on its own', async () => {
    const { service } = await setUp();
    const view = await service.view('u1', 't1');
    expect(view).toEqual({ ok: true, value: { rows: [
      { agent: 'leaf-judge', name: 'Leaf judge', own: { modelId: 'vllm' }, noMachine: true },
      { agent: 'planner', name: 'Planner', own: { machine: 'machine:dev-1:gemini' }, noMachine: true },
      { agent: 'executor', name: 'Executor', describe: 'Does the tasks', own: { modelId: 'tabby' } },
    ] } });
  });

  it('keeps a choice per agent, gives it to that agent alone, and clears it back to the agent\'s own', async () => {
    const { db, service } = await setUp();
    const set = await service.set('u1', 't1', { agent: 'leaf-judge', modelId: 'tabby' });
    expect(set.ok && set.value.rows.find((row) => row.agent === 'leaf-judge')?.chosen).toEqual({ modelId: 'tabby' });
    expect(await service.modelFor('u1', 't1', 'leaf-judge')).toEqual({ modelId: 'tabby' });
    expect(await service.modelFor('u1', 't1', 'executor')).toEqual({});
    expect(await service.modelFor('u1', 'elsewhere', 'executor')).toBeUndefined();

    await service.set('u1', 't1', { agent: 'leaf-judge', modelId: null });
    expect((await db.getTrees()).find((tree) => tree.id === 't1')?.models).toBeUndefined();
  });

  it('takes an agent on one of the person\'s machines, connected or not, for an agent whose procedure hands work to a machine', async () => {
    const { service } = await setUp();
    const set = await service.set('u1', 't1', { agent: 'executor', modelId: 'machine:dev-1:antigravity' });
    expect(set.ok && set.value.rows.find((row) => row.agent === 'executor')?.chosen).toEqual({ modelId: 'machine:dev-1:antigravity' });
    expect(await service.modelFor('u1', 't1', 'executor')).toEqual({ modelId: 'machine:dev-1:antigravity' });
    expect(await service.describe('u1', 't1')).toContain('- Executor (executor): antigravity on the person\'s machine (id machine:dev-1:antigravity), chosen for this tree');
  });

  it('refuses a machine whose agent is not ready, a machine that is not yours, and an agent whose procedure has no machine path', async () => {
    const { service } = await setUp();
    expect(await service.set('u1', 't1', { agent: 'executor', modelId: 'machine:dev-1:gemini' })).toEqual({ ok: false, status: 400, error: 'Gemini CLI on OZ-001 is not ready: Google refuses personal sign-ins' });
    expect(await service.set('u1', 't1', { agent: 'executor', modelId: 'machine:dev-9:antigravity' })).toEqual({ ok: false, status: 400, error: 'that machine is not one of yours any more; pick another on My Machines or in the model list' });
    expect(await service.set('u1', 't1', { agent: 'leaf-judge', modelId: 'machine:dev-1:antigravity' })).toEqual({ ok: false, status: 400, error: 'Leaf judge\'s procedure has no way to hand its work to a machine; give it a Where It Runs step, or choose one of your models' });
  });

  it('says when a chosen machine can no longer do the work', async () => {
    const { db, service } = await setUp();
    const tree = (await db.getTrees()).find((entry) => entry.id === 't1')!;
    await db.saveTree({ ...tree, models: { executor: 'machine:dev-1:gemini' } });
    const view = await service.view('u1', 't1');
    expect(view.ok && view.value.rows.find((row) => row.agent === 'executor')?.chosen).toEqual({ modelId: 'machine:dev-1:gemini', gone: true });
  });

  it('refuses a model that is not yours, an agent outside the work, and an agent that always runs on its machine', async () => {
    const { service } = await setUp();
    expect(await service.set('u1', 't1', { agent: 'executor', modelId: 'openrouter-x' })).toEqual({ ok: false, status: 400, error: 'There is no model openrouter-x among yours' });
    expect(await service.set('u1', 't1', { agent: 'grove', modelId: 'tabby' })).toEqual({ ok: false, status: 400, error: 'grove asks no model anything in this tree\'s work, so it has no model to choose' });
    expect(await service.set('u1', 't1', { agent: 'planner', modelId: 'tabby' })).toEqual({ ok: false, status: 400, error: 'Planner always runs on its machine; change where it runs in the Studio' });
    expect(await service.set('u2', 't1', { agent: 'executor', modelId: 'tabby' })).toEqual({ ok: false, status: 404, error: 'Tree not found' });
  });

  it('says when a chosen model is gone', async () => {
    const { db, service } = await setUp();
    const tree = (await db.getTrees()).find((entry) => entry.id === 't1')!;
    await db.saveTree({ ...tree, models: { executor: 'deleted-model' } });
    const view = await service.view('u1', 't1');
    expect(view.ok && view.value.rows.find((row) => row.agent === 'executor')?.chosen).toEqual({ modelId: 'deleted-model', gone: true });
  });

  it('describes them for Koala, with the ids to name', async () => {
    const { service } = await setUp();
    await service.set('u1', 't1', { agent: 'leaf-judge', modelId: 'tabby' });
    expect(await service.describe('u1', 't1')).toBe([
      'Models in this tree\'s work:',
      '- Leaf judge (leaf-judge): Tabby (id tabby), chosen for this tree',
      '- Planner (planner): always on its machine, set in the Studio',
      '- Executor (executor): its own, Tabby (id tabby)',
    ].join('\n'));
  });
});
