import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { GroveDeletionService, type GroveDeletionDeps } from './GroveDeletionService.js';

const at = 'now';

async function setUp() {
  const db = memoryDatabase();
  const workflows = mock<GroveDeletionDeps['workflows']>();
  const workspaces = mock<GroveDeletionDeps['workspaces']>();
  workflows.stop.mockResolvedValue(false);
  const service = new GroveDeletionService({ store: db, workflows, workspaces });
  for (const [id, ownerId] of [['t1', 'ann'], ['keep', 'ann'], ['theirs', 'bo']] as const) await db.projects.saveTree({ id, ownerId, name: id, type: 'api-service', createdAt: at, updatedAt: at });
  for (const [id, treeId, ownerId] of [['b1', 't1', 'ann'], ['b2', 't1', 'ann'], ['b-keep', 'keep', 'ann'], ['b-theirs', 'theirs', 'bo']] as const) await db.projects.saveBranch({ id, ownerId, treeId, title: id, createdAt: at, updatedAt: at });
  for (const [id, branchId, ownerId] of [['l1', 'b1', 'ann'], ['l2', 'b2', 'ann'], ['l-keep', 'b-keep', 'ann'], ['l-theirs', 'b-theirs', 'bo']] as const) await db.projects.saveLeaf({ id, ownerId, branchId, title: id, status: 'pending', createdAt: at, updatedAt: at });
  await db.projects.saveTask({ id: 'k1', ownerId: 'ann', leafId: 'l1', title: 'T', doneMeans: 'd', dependsOn: [], status: 'accepted', runs: [], createdAt: at, updatedAt: at });
  await db.projects.saveTask({ id: 'k-keep', ownerId: 'ann', leafId: 'l-keep', title: 'T', doneMeans: 'd', dependsOn: [], status: 'accepted', runs: [], createdAt: at, updatedAt: at });
  await db.engine.saveConversation({ id: 'c1', ownerId: 'ann', title: 'about t1', treeId: 't1', messages: [], createdAt: at, updatedAt: at });
  await db.engine.saveConversation({ id: 'c-keep', ownerId: 'ann', title: 'about keep', treeId: 'keep', messages: [], createdAt: at, updatedAt: at });
  await db.projects.savePlanProposal({ id: 'p1', ownerId: 'ann', status: 'adopting', leafPlan: { treeId: 't1', leafId: 'l1', leafTitle: 'L', mode: 'replan', why: 'w', brief: 'b', tasks: [] }, createdAt: at, updatedAt: at });
  return { db, workflows, workspaces, service };
}

describe('deleting a tree', () => {
  it('stops its run and the adoption of its plans, then takes its branches, stories, tasks, plans, chats and sandbox', async () => {
    const { db, workflows, workspaces, service } = await setUp();
    workflows.stop.mockResolvedValueOnce(true);
    const outcome = await service.deleteTree('ann', 't1');
    expect(outcome).toMatchObject({ ok: true, value: { stoppedRun: true, scope: { treeId: 't1', branchIds: ['b1', 'b2'], leafIds: ['l1', 'l2'], taskIds: ['k1'], proposalIds: ['p1'], adoptingProposalIds: ['p1'], conversationIds: ['c1'] } } });
    expect(workflows.stop.mock.calls.map(([id]) => id)).toEqual(['grove-run-t1', 'adopt-plan-p1']);
    expect(workflows.stop).toHaveBeenCalledWith('grove-run-t1', 'tree t1 was deleted');
    expect(workspaces.release).toHaveBeenCalledWith('t1', 'ann');
    expect((await db.projects.getTrees()).map((tree) => tree.id)).toEqual(['keep', 'theirs']);
    expect((await db.projects.getBranches()).map((branch) => branch.id)).toEqual(['b-keep', 'b-theirs']);
    expect((await db.projects.getLeaves()).map((leaf) => leaf.id)).toEqual(['l-keep', 'l-theirs']);
    expect((await db.projects.getTasks('ann')).map((task) => task.id)).toEqual(['k-keep']);
    expect((await db.engine.getConversations()).map((chat) => chat.id)).toEqual(['c-keep']);
    expect(await db.projects.getPlanProposals('ann')).toEqual([]);
  });

  it('answers 404 for a tree that is another owner\'s or not there, touching nothing', async () => {
    const { db, workflows, service } = await setUp();
    expect(await service.deleteTree('ann', 'theirs')).toEqual({ ok: false, status: 404, error: 'Tree not found' });
    expect(await service.deleteTree('ann', 'nope')).toEqual({ ok: false, status: 404, error: 'Tree not found' });
    expect(workflows.stop).not.toHaveBeenCalled();
    expect(await db.projects.getTrees()).toHaveLength(3);
  });

  it('deletes nothing when the sandbox could not be saved first', async () => {
    const { db, workspaces, service } = await setUp();
    workspaces.release.mockRejectedValue(new Error('Pushing to koala-u1/tree-t1 failed: Gitea is down'));
    await expect(service.deleteTree('ann', 't1')).rejects.toThrow('Gitea is down');
    expect((await db.projects.getTrees()).map((tree) => tree.id)).toContain('t1');
    expect((await db.projects.getLeaves()).map((leaf) => leaf.id)).toContain('l1');
  });
});

describe('deleting a branch', () => {
  it('takes the branch with its stories, their tasks and its adopting plans, leaving the tree and its sandbox', async () => {
    const { db, workflows, workspaces, service } = await setUp();
    const outcome = await service.deleteBranch('ann', 'b1');
    expect(outcome).toMatchObject({ ok: true, value: { stoppedRun: false, scope: { branchIds: ['b1'], leafIds: ['l1'], taskIds: ['k1'], proposalIds: ['p1'] } } });
    expect(workflows.stop.mock.calls.map(([id, reason]) => [id, reason])).toEqual([['grove-run-t1', 'branch b1 was deleted'], ['adopt-plan-p1', 'branch b1 was deleted']]);
    expect(workspaces.release).not.toHaveBeenCalled();
    expect((await db.projects.getBranches()).map((branch) => branch.id)).toEqual(['b2', 'b-keep', 'b-theirs']);
    expect((await db.projects.getTrees()).map((tree) => tree.id)).toContain('t1');
  });

  it('answers 404 for another owner\'s branch', async () => {
    const { workflows, service } = await setUp();
    expect(await service.deleteBranch('ann', 'b-theirs')).toEqual({ ok: false, status: 404, error: 'Branch not found' });
    expect(workflows.stop).not.toHaveBeenCalled();
  });
});

describe('deleting a leaf', () => {
  it('takes the story and its tasks, stopping the run of the tree it belongs to', async () => {
    const { db, workflows, service } = await setUp();
    const outcome = await service.deleteLeaf('ann', 'l1');
    expect(outcome).toMatchObject({ ok: true, value: { scope: { branchIds: [], leafIds: ['l1'], taskIds: ['k1'] } } });
    expect(workflows.stop).toHaveBeenCalledWith('grove-run-t1', 'leaf l1 was deleted');
    expect((await db.projects.getLeaves()).map((leaf) => leaf.id)).toEqual(['l2', 'l-keep', 'l-theirs']);
    expect((await db.projects.getBranches()).map((branch) => branch.id)).toContain('b1');
  });

  it('stops no run for a story whose branch is gone, and answers 404 for another owner\'s', async () => {
    const { db, workflows, service } = await setUp();
    await db.projects.saveLeaf({ id: 'orphan', ownerId: 'ann', branchId: 'missing', title: 'o', status: 'pending', createdAt: at, updatedAt: at });
    expect(await service.deleteLeaf('ann', 'orphan')).toMatchObject({ ok: true, value: { stoppedRun: false } });
    expect(workflows.stop).not.toHaveBeenCalled();
    expect(await service.deleteLeaf('ann', 'l-theirs')).toEqual({ ok: false, status: 404, error: 'Leaf not found' });
  });
});
