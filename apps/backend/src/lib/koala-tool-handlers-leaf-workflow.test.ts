import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { seedAll } from '../scripts/seed-all.js';
import {
  handleCreateTreeType, handleGetTreeType,
  handleAddWorkflowStage, handleAddWorkflowGroup, handleAddWorkflowLoop,
  handleReviseWorkflowStage, handleRemoveWorkflowStage, handleReorderWorkflowStages,
  type KoalaToolContext,
} from './koala-tool-handlers.js';

let db: MemoryDB;
const userId = 'u1';

const ctx = (): KoalaToolContext => ({ db, userId } as unknown as KoalaToolContext);
const body = (out: { content: string }) => JSON.parse(out.content);
const last = (arr: any[]): any => arr[arr.length - 1];

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
  await seedAll(db as never);
});

async function createType(id = 'widget') {
  const out = await handleCreateTreeType(ctx(), {
    id, label: 'Widget', summary: 'A widget.', doneMeans: 'It works.', language: 'node', produces: 'service',
  });
  expect(body(out).created).toBeDefined();
  return id;
}

describe('get_tree_type shows the effective leaf workflow even before customization', () => {
  it('fills in the default sequence when none has been saved', async () => {
    const id = await createType();
    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.leafWorkflow.onSuccess.map((n: { stage: string }) => n.stage))
      .toEqual(['release', 'judge', 'land', 'resolve', 'accept', 'replan']);
    expect(got.treeType.leafWorkflow.onFailure.map((n: { stage: string }) => n.stage)).toEqual(['release', 'land']);
  });
});

describe('add_workflow_stage', () => {
  it('appends a stage onto the effective onSuccess sequence', async () => {
    const id = await createType();
    const out = await handleAddWorkflowStage(ctx(), { id, which: 'onSuccess', name: 'Judge it again', stage: 'judge' });
    const stageId = body(out).added.id;

    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.leafWorkflow.onSuccess).toHaveLength(7);
    expect(last(got.treeType.leafWorkflow.onSuccess)).toMatchObject({ id: stageId, name: 'Judge it again', stage: 'judge' });
  });

  it('appends independently to onFailure', async () => {
    const id = await createType();
    await handleAddWorkflowStage(ctx(), { id, which: 'onFailure', name: 'Land again', stage: 'land' });
    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.leafWorkflow.onFailure).toHaveLength(3);
    expect(got.treeType.leafWorkflow.onSuccess).toHaveLength(6);
  });

  it('refuses an unknown stage type', async () => {
    const id = await createType();
    const out = await handleAddWorkflowStage(ctx(), { id, which: 'onSuccess', name: 'X', stage: 'bogus' });
    expect(body(out).error).toMatch(/stage must be one of/i);
  });

  it('refuses a missing which', async () => {
    const id = await createType();
    const out = await handleAddWorkflowStage(ctx(), { id, name: 'X', stage: 'judge' });
    expect(body(out).error).toMatch(/which/i);
  });

  it('accepts a condition-object runIf referencing an earlier stage\'s output', async () => {
    const id = await createType();
    const out = await handleAddWorkflowStage(ctx(), {
      id, which: 'onSuccess', name: 'Resolve again', stage: 'resolve',
      runIf: { op: 'gt', path: 'stages.land.output.stuck.length', value: 0 },
    });
    expect(body(out).added).toBeDefined();

    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(last(got.treeType.leafWorkflow.onSuccess).runIf).toEqual({ op: 'gt', path: 'stages.land.output.stuck.length', value: 0 });
  });
});

describe('add_workflow_group / add_workflow_loop', () => {
  it('adds a group, then a stage nested inside it', async () => {
    const id = await createType();
    const groupOut = await handleAddWorkflowGroup(ctx(), { id, which: 'onSuccess', name: 'Post-run' });
    const groupId = body(groupOut).added.id;

    await handleAddWorkflowStage(ctx(), { id, which: 'onSuccess', parentId: groupId, name: 'Land again', stage: 'land' });

    const got = body(await handleGetTreeType(ctx(), { id }));
    const group = last(got.treeType.leafWorkflow.onSuccess);
    expect(group.containerType).toBe('group');
    expect(group.children).toHaveLength(1);
    expect(group.children[0].name).toBe('Land again');
  });

  it('adds a count loop requiring maxIterations', async () => {
    const id = await createType();
    const missing = await handleAddWorkflowLoop(ctx(), { id, which: 'onSuccess', name: 'Retry', loopType: 'count' });
    expect(body(missing).error).toMatch(/maxIterations/i);

    const ok = await handleAddWorkflowLoop(ctx(), { id, which: 'onSuccess', name: 'Retry', loopType: 'count', maxIterations: 3 });
    expect(body(ok).added).toBeDefined();
  });

  it('adds a forEach loop requiring itemsFrom', async () => {
    const id = await createType();
    const missing = await handleAddWorkflowLoop(ctx(), { id, which: 'onSuccess', name: 'PerItem', loopType: 'forEach' });
    expect(body(missing).error).toMatch(/itemsFrom/i);

    const ok = await handleAddWorkflowLoop(ctx(), {
      id, which: 'onSuccess', name: 'PerItem', loopType: 'forEach', itemsFrom: 'stages.land.output.stuck',
    });
    expect(body(ok).added).toBeDefined();
  });
});

describe('revise_workflow_stage', () => {
  it('revises the shipped judge stage\'s fields', async () => {
    const id = await createType();
    const before = body(await handleGetTreeType(ctx(), { id }));
    const judgeId = before.treeType.leafWorkflow.onSuccess.find((n: { stage: string }) => n.stage === 'judge').id;

    await handleReviseWorkflowStage(ctx(), { id, which: 'onSuccess', stageId: judgeId, name: 'Judge renamed', optional: false });
    const got = body(await handleGetTreeType(ctx(), { id }));
    const judge = got.treeType.leafWorkflow.onSuccess.find((n: { id: string }) => n.id === judgeId);
    expect(judge).toMatchObject({ name: 'Judge renamed', optional: false });
  });

  it('clears runIf when passed an empty string', async () => {
    const id = await createType();
    const stageOut = await handleAddWorkflowStage(ctx(), { id, which: 'onSuccess', name: 'Extra', stage: 'judge', runIf: 'land' });
    const stageId = body(stageOut).added.id;

    const before = body(await handleGetTreeType(ctx(), { id }));
    expect(last(before.treeType.leafWorkflow.onSuccess).runIf).toBe('land');

    await handleReviseWorkflowStage(ctx(), { id, which: 'onSuccess', stageId, runIf: '' });
    const after = body(await handleGetTreeType(ctx(), { id }));
    expect(last(after.treeType.leafWorkflow.onSuccess).runIf).toBeUndefined();
  });

  it('revises a loop\'s loopType and its conditional fields', async () => {
    const id = await createType();
    const loopOut = await handleAddWorkflowLoop(ctx(), { id, which: 'onSuccess', name: 'Loop', loopType: 'count', maxIterations: 3 });
    const loopId = body(loopOut).added.id;

    await handleReviseWorkflowStage(ctx(), { id, which: 'onSuccess', stageId: loopId, loopType: 'forEach', itemsFrom: 'stages.a.output.b' });
    const got = body(await handleGetTreeType(ctx(), { id }));
    const loop = last(got.treeType.leafWorkflow.onSuccess);
    expect(loop).toMatchObject({ loopType: 'forEach', itemsFrom: 'stages.a.output.b' });
  });
});

describe('remove_workflow_stage', () => {
  it('removes a stage and clears a dangling runIf reference to it', async () => {
    const id = await createType();
    const aOut = await handleAddWorkflowStage(ctx(), { id, which: 'onSuccess', name: 'Extra A', stage: 'judge' });
    const aId = body(aOut).added.id;
    const bOut = await handleAddWorkflowStage(ctx(), { id, which: 'onSuccess', name: 'Extra B', stage: 'accept', runIf: aId });
    const bId = body(bOut).added.id;

    await handleRemoveWorkflowStage(ctx(), { id, which: 'onSuccess', stageId: aId });

    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.leafWorkflow.onSuccess).toHaveLength(7);
    const b = got.treeType.leafWorkflow.onSuccess.find((n: { id: string }) => n.id === bId);
    expect(b.runIf).toBeUndefined();
  });
});

describe('reorder_workflow_stages', () => {
  it('reorders stages at the top level', async () => {
    const id = await createType();
    const before = body(await handleGetTreeType(ctx(), { id }));
    const currentIds = before.treeType.leafWorkflow.onFailure.map((n: { id: string }) => n.id);
    const reversed = [...currentIds].reverse();

    await handleReorderWorkflowStages(ctx(), { id, which: 'onFailure', orderedStageIds: reversed });
    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.leafWorkflow.onFailure.map((n: { id: string }) => n.id)).toEqual(reversed);
  });

  it('refuses a reorder list that does not name exactly the current ids', async () => {
    const id = await createType();
    const out = await handleReorderWorkflowStages(ctx(), { id, which: 'onFailure', orderedStageIds: ['release'] });
    expect(body(out).error).toMatch(/orderedStageIds/i);
  });
});
