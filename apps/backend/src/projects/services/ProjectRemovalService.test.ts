import { workFor, withWorkFor } from '@koala/engine-core/work-for';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { AccountRemovalWorkflows } from '../../accounts/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { ProjectRemovalStep } from '../lib/project-removal.js';
import { loadProjectScope, ProjectRemovalService, type ProjectPurges } from './ProjectRemovalService.js';

const at = '2026-10-21T00:00:00Z';
type Workflows = AccountRemovalWorkflows<{ projectId: string; mode: 'archive' | 'permanent' }, ProjectRemovalStep>;

async function setUp() {
  const db = memoryDatabase();
  const workflows = mock<Workflows>();
  workflows.state.mockResolvedValue({ state: 'none' });
  const purges = mock<ProjectPurges>();
  const service = new ProjectRemovalService({ store: db, workflows, purges, now: () => at });
  await db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: 'ann', giteaOwner: 'koala-ann', giteaRepo: 'shop', appType: 'gitapp', createdAt: at });
  await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop tree', type: 'odoo-addons', projectIds: ['p1'], createdAt: at, updatedAt: at });
  await db.projects.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: at, updatedAt: at });
  await db.projects.saveLeaf({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Checkout', status: 'pending', createdAt: at, updatedAt: at });
  await db.engine.saveConversation({ id: 'about-tree', ownerId: 'ann', title: 't', treeId: 't1', messages: [], createdAt: at, updatedAt: at });
  await db.engine.saveConversation({ id: 'side', ownerId: 'ann', title: 's', projectId: 'p1', messages: [], createdAt: at, updatedAt: at });
  await db.releases.savePipelineRunInfo({ id: 'run-1', projectId: 'p1', commitSha: 'abc', ref: 'main', status: 'running', temporalWorkflowId: 'build-1', startedAt: at });
  return { db, workflows, purges, service };
}

describe('what deleting a project takes', () => {
  it('is read from the project\'s trees, chats, builds and repository', async () => {
    const { db } = await setUp();
    const loaded = await loadProjectScope(db, 'p1');
    expect(loaded?.project.id).toBe('p1');
    expect(loaded?.scope).toMatchObject({
      projectId: 'p1', repository: 'koala-ann/shop',
      trees: [{ id: 't1', name: 'Shop tree', scope: { leafIds: ['l1'], conversationIds: ['about-tree'] } }],
      keptConversationIds: ['side'], pipelineRunIds: ['run-1'], runningBuildWorkflowIds: ['build-1'],
    });
  });

  it('is nothing for a project that is not there, and counts only the owner\'s records', async () => {
    const { db } = await setUp();
    expect(await loadProjectScope(db, 'nope')).toBeUndefined();
    await db.projects.saveLeaf({ id: 'l-other', ownerId: 'bo', branchId: 'b1', title: 'x', status: 'pending', createdAt: at, updatedAt: at });
    expect((await loadProjectScope(db, 'p1'))?.scope.trees[0]?.scope.leafIds).toEqual(['l1']);
  });
});

describe('previewing a project\'s deletion', () => {
  it('lists what goes and where the removal stands', async () => {
    const { service } = await setUp();
    const preview = await service.preview('ann', 'p1');
    expect(preview).toMatchObject({ name: 'Shop', repository: 'koala-ann/shop', trees: [{ id: 't1', name: 'Shop tree', leaves: 1, conversations: 1 }], keptConversations: 1, builds: 1 });
    expect(preview).not.toHaveProperty('deletion');
  });

  it('carries where a deletion stands, as its deletion last told it, without asking Temporal', async () => {
    const { db, workflows, service } = await setUp();
    await db.projects.markDeleting('p1', { startedAt: at, requestedBy: 'ann', mode: 'archive' });
    const progress = { seq: 3, phase: 'deleting' as const, work: [{ workflowId: 'run-1', type: 'AgentRunWorkflow', startedAt: at, state: 'stopping' as const, what: 'Tree run: Shop tree' }], parts: {} };
    await db.projects.saveDeletionProgress('p1', progress);
    expect((await service.preview('ann', 'p1'))?.deletion).toEqual({ startedAt: at, requestedBy: 'ann', mode: 'archive', phase: 'deleting', progress });
    expect(workflows.state).not.toHaveBeenCalled();
  });

  it('shows nothing of a project that is another owner\'s or not there', async () => {
    const { service } = await setUp();
    expect(await service.preview('bo', 'p1')).toBeUndefined();
    expect(await service.preview('ann', 'nope')).toBeUndefined();
  });
});

describe('deleting a project', () => {
  it('needs the project\'s name typed, and starts nothing without it', async () => {
    const { workflows, service } = await setUp();
    expect(await service.remove('ann', 'p1', 'shop', 'permanent')).toEqual({ ok: false, refusal: { status: 400, error: 'Type the project\'s name, Shop, to confirm' } });
    expect(workflows.start).not.toHaveBeenCalled();
  });

  it('404s a project that is another owner\'s', async () => {
    const { workflows, service } = await setUp();
    expect(await service.remove('bo', 'p1', 'Shop', 'permanent')).toEqual({ ok: false, refusal: { status: 404, error: 'Project not found' } });
    expect(workflows.start).not.toHaveBeenCalled();
  });

  it('marks the project as being removed and starts the removal as its owner', async () => {
    const { db, workflows, service } = await setUp();
    const removed = await service.remove('ann', 'p1', ' Shop ', 'permanent');
    expect(removed).toEqual({ ok: true, deletion: { startedAt: at, requestedBy: 'ann', mode: 'permanent', phase: 'deleting' } });
    expect(workflows.start).toHaveBeenCalledWith('DeleteProjectWorkflow', 'delete-project-p1', [{ projectId: 'p1', mode: 'permanent' }], 'ann');
    expect((await db.projects.getProjects())[0]?.removal).toEqual({ startedAt: at, requestedBy: 'ann', mode: 'permanent', phase: 'deleting' });
  });

  it('starts the deletion as the project\'s own removal, whatever work it is called from, so the refusals let only it through', async () => {
    const { workflows, service } = await setUp();
    let named: unknown;
    workflows.start.mockImplementation(async () => { named = workFor(); });
    await withWorkFor({ owner: 'ann', project: 'other' }, () => service.remove('ann', 'p1', 'Shop', 'permanent'));
    expect(named).toEqual({ owner: 'ann', project: 'p1', removing: 'project' });
  });

  it('marks the project once: pressed again after it stopped, the deletion starts again under the first mark', async () => {
    const { db, workflows, purges } = await setUp();
    let now = at;
    const service = new ProjectRemovalService({ store: db, workflows, purges, now: () => now });
    await service.remove('ann', 'p1', 'Shop', 'permanent');
    now = '2026-10-22T00:00:00Z';
    workflows.state.mockResolvedValue({ state: 'failed', reason: 'Gitea answered 403' });
    await service.remove('ann', 'p1', 'Shop', 'archive');
    expect(workflows.start).toHaveBeenCalledTimes(2);
    expect(workflows.start).toHaveBeenLastCalledWith('DeleteProjectWorkflow', 'delete-project-p1', [{ projectId: 'p1', mode: 'permanent' }], 'ann');
    expect(await db.projects.deletion('p1')).toEqual({ startedAt: at, requestedBy: 'ann', mode: 'permanent', phase: 'deleting' });
  });

  it('starts nothing for a project already deleted and kept, and shows its deletion as it ended', async () => {
    const { db, workflows, service } = await setUp();
    await db.projects.markDeleting('p1', { startedAt: at, requestedBy: 'ann', mode: 'archive' });
    await db.projects.archive('p1');
    expect(await service.remove('ann', 'p1', 'Shop', 'archive')).toEqual({ ok: true, deletion: { startedAt: at, requestedBy: 'ann', mode: 'archive', phase: 'archived' } });
    expect(workflows.start).not.toHaveBeenCalled();
  });

  it('keeps the project archived when asked to, and says so to the deletion it starts', async () => {
    const { db, workflows, service } = await setUp();
    await service.remove('ann', 'p1', 'Shop', 'archive');
    expect(workflows.start).toHaveBeenCalledWith('DeleteProjectWorkflow', 'delete-project-p1', [{ projectId: 'p1', mode: 'archive' }], 'ann');
    expect(await db.projects.deletion('p1')).toEqual({ startedAt: at, requestedBy: 'ann', mode: 'archive', phase: 'deleting' });
  });

  it('starts nothing when a removal is already running', async () => {
    const { workflows, service } = await setUp();
    workflows.state.mockResolvedValue({ state: 'running', done: [] });
    expect(await service.remove('ann', 'p1', 'Shop', 'permanent')).toEqual({ ok: true, deletion: { startedAt: at, requestedBy: 'ann', mode: 'permanent', phase: 'deleting' } });
    expect(workflows.start).not.toHaveBeenCalled();
  });
});

describe('a deleted project kept for its 90 days', () => {
  const archived = async () => {
    const world = await setUp();
    await world.db.projects.markDeleting('p1', { startedAt: at, requestedBy: 'ann', mode: 'archive' });
    await world.db.projects.archive('p1');
    return world;
  };

  it('is listed under Deleted projects with the date Temporal holds for it, and only for its owner', async () => {
    const { purges, service } = await archived();
    purges.keptUntil.calledWith('p1').mockResolvedValue(new Date('2027-01-19T00:00:00Z'));
    expect(await service.deleted('ann')).toEqual([{ id: 'p1', name: 'Shop', deletedAt: at, keptUntil: '2027-01-19T00:00:00.000Z' }]);
    expect(await service.deleted('bo')).toEqual([]);
  });

  it('is restored with its name, after its purge is told to end without deleting anything', async () => {
    const { db, purges, service } = await archived();
    expect(await service.restore('ann', 'p1')).toEqual({ ok: true, name: 'Shop', renamed: false });
    expect(purges.restore).toHaveBeenCalledWith('p1', 'ann');
    expect(await db.projects.deletion('p1')).toBeUndefined();
  });

  it('is restored as "<name> (restored)" when a project of that name exists now, and says so', async () => {
    const { db, service } = await archived();
    await db.projects.saveProject({ id: 'p2', name: 'Shop', ownerId: 'ann', giteaOwner: 'koala-ann', giteaRepo: 'shop-2', appType: 'gitapp', createdAt: at });
    expect(await service.restore('ann', 'p1')).toEqual({ ok: true, name: 'Shop (restored)', renamed: true });
    expect((await db.projects.getProjects()).find((project) => project.id === 'p1')?.name).toBe('Shop (restored)');
  });

  it('is deleted for good now when its name is typed, through its purge', async () => {
    const { purges, service } = await archived();
    expect(await service.purgeNow('ann', 'p1', 'shop')).toEqual({ ok: false, refusal: { status: 400, error: 'Type the project\'s name, Shop, to confirm' } });
    expect(purges.now).not.toHaveBeenCalled();
    expect(await service.purgeNow('ann', 'p1', 'Shop')).toEqual({ ok: true });
    expect(purges.now).toHaveBeenCalledWith('p1', 'ann');
  });

  it('cannot be restored or deleted now by someone else, or while it is not kept', async () => {
    const world = await setUp();
    expect(await world.service.restore('ann', 'p1')).toEqual({ ok: false, refusal: { status: 409, error: 'Only a deleted project kept for its 90 days can be restored' } });
    const { service, purges } = await archived();
    expect(await service.restore('bo', 'p1')).toEqual({ ok: false, refusal: { status: 404, error: 'Project not found' } });
    expect(await service.purgeNow('bo', 'p1', 'Shop')).toEqual({ ok: false, refusal: { status: 404, error: 'Project not found' } });
    expect(purges.restore).not.toHaveBeenCalled();
  });
});
