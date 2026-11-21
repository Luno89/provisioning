import { withWorkFor, workIsUnnamed } from '@koala/engine-core/work-for';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { AccountRemovalWorkflows } from '../../accounts/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { ProjectRemovalStep } from '../lib/project-removal.js';
import { loadProjectScope, ProjectRemovalService } from './ProjectRemovalService.js';

const at = '2026-10-21T00:00:00Z';
type Workflows = AccountRemovalWorkflows<{ projectId: string }, ProjectRemovalStep>;

async function setUp() {
  const db = memoryDatabase();
  const workflows = mock<Workflows>();
  workflows.state.mockResolvedValue({ state: 'none' });
  const service = new ProjectRemovalService({ store: db, workflows, now: () => at });
  await db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: 'ann', giteaOwner: 'koala-ann', giteaRepo: 'shop', appType: 'gitapp', createdAt: at });
  await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop tree', type: 'odoo-addons', projectIds: ['p1'], createdAt: at, updatedAt: at });
  await db.projects.saveBranch({ id: 'b1', ownerId: 'ann', treeId: 't1', title: 'Pay', createdAt: at, updatedAt: at });
  await db.projects.saveLeaf({ id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Checkout', status: 'pending', createdAt: at, updatedAt: at });
  await db.engine.saveConversation({ id: 'about-tree', ownerId: 'ann', title: 't', treeId: 't1', messages: [], createdAt: at, updatedAt: at });
  await db.engine.saveConversation({ id: 'side', ownerId: 'ann', title: 's', projectId: 'p1', messages: [], createdAt: at, updatedAt: at });
  await db.releases.savePipelineRunInfo({ id: 'run-1', projectId: 'p1', commitSha: 'abc', ref: 'main', status: 'running', temporalWorkflowId: 'build-1', startedAt: at });
  return { db, workflows, service };
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
    expect(preview).toMatchObject({ name: 'Shop', repository: 'koala-ann/shop', trees: [{ id: 't1', name: 'Shop tree', leaves: 1, conversations: 1 }], keptConversations: 1, builds: 1, state: { state: 'none' } });
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
    expect(await service.remove('ann', 'p1', 'shop')).toEqual({ ok: false, refusal: { status: 400, error: 'Type the project\'s name, Shop, to confirm' } });
    expect(workflows.start).not.toHaveBeenCalled();
  });

  it('404s a project that is another owner\'s', async () => {
    const { workflows, service } = await setUp();
    expect(await service.remove('bo', 'p1', 'Shop')).toEqual({ ok: false, refusal: { status: 404, error: 'Project not found' } });
    expect(workflows.start).not.toHaveBeenCalled();
  });

  it('marks the project as being removed and starts the removal as its owner', async () => {
    const { db, workflows, service } = await setUp();
    workflows.state.mockResolvedValueOnce({ state: 'none' }).mockResolvedValueOnce({ state: 'running', done: [] });
    const removed = await service.remove('ann', 'p1', ' Shop ');
    expect(removed).toEqual({ ok: true, state: { state: 'running', done: [] } });
    expect(workflows.start).toHaveBeenCalledWith('RemoveProjectWorkflow', 'remove-project-p1', [{ projectId: 'p1' }], 'ann');
    expect((await db.projects.getProjects())[0]?.removal).toEqual({ startedAt: at, requestedBy: 'ann' });
  });

  it('starts the deletion as work for nobody, so the fence it raises round the project never stops its own steps', async () => {
    const { workflows, service } = await setUp();
    let unnamed: boolean | undefined;
    workflows.start.mockImplementation(async () => { unnamed = workIsUnnamed(); });
    await withWorkFor({ owner: 'ann', project: 'p1' }, () => service.remove('ann', 'p1', 'Shop'));
    expect(unnamed).toBe(true);
  });

  it('starts nothing when a removal is already running', async () => {
    const { workflows, service } = await setUp();
    workflows.state.mockResolvedValue({ state: 'running', done: [] });
    expect(await service.remove('ann', 'p1', 'Shop')).toEqual({ ok: true, state: { state: 'running', done: [] } });
    expect(workflows.start).not.toHaveBeenCalled();
  });

});
