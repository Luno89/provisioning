import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { GroveOrderService } from './GroveOrderService.js';

async function setUp() {
  const db = memoryDatabase();
  const service = new GroveOrderService({ store: db.projects, now: () => 'stamped' });
  await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'mine', type: 'api-service', createdAt: 'then', updatedAt: 'then' });
  await db.projects.saveTree({ id: 't2', ownerId: 'bo', name: 'theirs', type: 'api-service', createdAt: 'then', updatedAt: 'then' });
  for (const [id, treeId, ownerId] of [['b1', 't1', 'ann'], ['b2', 't1', 'ann'], ['bx', 't9', 'ann'], ['b-theirs', 't2', 'bo']] as const) await db.projects.saveBranch({ id, ownerId, treeId, title: id, createdAt: 'then', updatedAt: 'then' });
  for (const id of ['l1', 'l2', 'l3']) await db.projects.saveLeaf({ id, ownerId: 'ann', branchId: 'b1', title: id, status: 'pending', createdAt: 'then', updatedAt: 'then' });
  return { db, service };
}

describe('ordering a feature\'s stories', () => {
  it('saves the new order as priorities and stamps only the stories whose place moved', async () => {
    const { db, service } = await setUp();
    expect(await service.orderStories('ann', 'b1', ['l3', 'l1', 'l2'])).toEqual({ ok: true, value: { ordered: 3 } });
    expect((await db.projects.getLeaves()).map((leaf) => [leaf.id, leaf.priority, leaf.updatedAt])).toEqual([['l1', 1, 'stamped'], ['l2', 2, 'stamped'], ['l3', 0, 'stamped']]);
    expect(await service.orderStories('ann', 'b1', ['l3', 'l1', 'l2'])).toEqual({ ok: true, value: { ordered: 0 } });
  });

  it('refuses an order that repeats a story, names one from elsewhere or is not a list, saving nothing', async () => {
    const { db, service } = await setUp();
    expect(await service.orderStories('ann', 'b1', ['l1', 'l1'])).toEqual({ ok: false, status: 400, error: 'a story appears twice in the order' });
    expect(await service.orderStories('ann', 'b1', ['l1', 'nope'])).toEqual({ ok: false, status: 400, error: 'nope is not among the stories here' });
    expect(await service.orderStories('ann', 'b1', 'l1')).toMatchObject({ ok: false, status: 400 });
    expect((await db.projects.getLeaves()).every((leaf) => leaf.priority === undefined)).toBe(true);
  });

  it('answers 404 for another owner\'s feature', async () => {
    const { service } = await setUp();
    expect(await service.orderStories('ann', 'b-theirs', ['l1'])).toEqual({ ok: false, status: 404, error: 'Feature not found' });
  });
});

describe('ordering a tree\'s features', () => {
  it('saves the order of the tree\'s own features', async () => {
    const { db, service } = await setUp();
    expect(await service.orderFeatures('ann', 't1', ['b2', 'b1'])).toEqual({ ok: true, value: { ordered: 2 } });
    expect((await db.projects.getBranches()).filter((branch) => branch.treeId === 't1').map((branch) => [branch.id, branch.priority])).toEqual([['b1', 1], ['b2', 0]]);
  });

  it('refuses a feature of another tree, and another owner\'s tree', async () => {
    const { service } = await setUp();
    expect(await service.orderFeatures('ann', 't1', ['bx'])).toEqual({ ok: false, status: 400, error: 'bx is not among the features here' });
    expect(await service.orderFeatures('ann', 't2', [])).toEqual({ ok: false, status: 404, error: 'Tree not found' });
  });
});
