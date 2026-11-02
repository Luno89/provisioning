import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { TreeWorkspaces } from '../../engine-host/sandboxes/tree-workspaces.js';
import type { GroveRunStatus } from '../../infrastructure/index.js';
import type { TreeModelsService } from '../../models/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { seedTreeTypes } from '../lib/tree-types.js';
import type { Tree } from '../lib/trees.js';
import type { GroveDeletionService } from '../services/GroveDeletionService.js';
import type { GroveOrderService } from '../services/GroveOrderService.js';
import type { GroveRunService } from '../services/GroveRunService.js';
import type { TreeHomeService } from '../services/TreeHomeService.js';
import type { TreeWorkspaceService, TreeWorkspaceView } from '../services/TreeWorkspaceService.js';
import { CALLER, del, get, post, put } from '../testing/route-call.js';
import { treesRouter, type TreePullRequest } from './trees.js';

const tree = (over: Partial<Tree> = {}): Tree => ({ id: 't1', ownerId: CALLER.id, name: 'widget', type: 'api-service', projectIds: [], createdAt: '2026-01-01', updatedAt: '2026-01-01', ...over });

async function setUp(extra: { landings?: { pullRequests(ownerId: string, treeId: string): Promise<TreePullRequest[]> } | undefined; withFile?: boolean } = {}) {
  const db = memoryDatabase();
  await seedTreeTypes(db.projects);
  const workspaces = mock<Pick<TreeWorkspaces, 'state' | 'release'>>();
  const runs = mock<Pick<GroveRunService, 'run' | 'status' | 'stop'>>();
  const deletion = mock<Pick<GroveDeletionService, 'deleteTree'>>();
  const order = mock<Pick<GroveOrderService, 'orderFeatures'>>();
  const home = mock<Pick<TreeHomeService, 'home'>>();
  const workspaceFile = mock<Pick<TreeWorkspaceService, 'view' | 'save'>>();
  const models = mock<Pick<TreeModelsService, 'view' | 'set'>>();
  const changed: string[] = [];
  home.home.mockImplementation(async (made) => made);
  const router = treesRouter({
    db, workspaces, runs, deletion, order, home, models,
    ...(extra.landings ? { landings: extra.landings } : {}),
    ...(extra.withFile === false ? {} : { workspaceFile }),
    changed: (ownerId) => { changed.push(ownerId); },
  });
  return { db, workspaces, runs, deletion, order, home, workspaceFile, models, changed, router };
}

describe('listing trees', () => {
  it('shows only the caller\'s trees, newest first, each with how many features it has', async () => {
    const { db, router } = await setUp();
    await db.projects.saveTree(tree({ id: 'old', updatedAt: '2026-01-01' }));
    await db.projects.saveTree(tree({ id: 'new', updatedAt: '2026-02-01' }));
    await db.projects.saveTree(tree({ id: 'theirs', ownerId: 'someone-else' }));
    await db.projects.saveBranch({ id: 'b1', ownerId: CALLER.id, treeId: 'new', title: 'B', createdAt: 't', updatedAt: 't' });
    await db.projects.saveBranch({ id: 'b2', ownerId: CALLER.id, treeId: 'new', title: 'B', createdAt: 't', updatedAt: 't' });
    await db.projects.saveBranch({ id: 'b3', ownerId: 'someone-else', treeId: 'new', title: 'B', createdAt: 't', updatedAt: 't' });
    const listed = (await get(router, '/')).body as (Tree & { branchCount: number })[];
    expect(listed.map((entry) => [entry.id, entry.branchCount])).toEqual([['new', 2], ['old', 0]]);
  });
});

describe('making a tree', () => {
  it('makes it for the session user whatever the body says, homes it and tells the owner\'s browsers', async () => {
    const { db, home, changed, router } = await setUp();
    const answer = await post(router, '/', { name: 'new', goal: 'g', type: 'research-paper', ownerId: 'someone-else' });
    expect(answer.status).toBe(201);
    const stored = (await db.projects.getTrees()).find((entry) => entry.name === 'new');
    expect(stored).toMatchObject({ ownerId: CALLER.id, type: 'research-paper', goal: 'g', projectIds: [] });
    expect(home.home).toHaveBeenCalledWith(matches<Tree>((made) => made.id === stored?.id));
    expect(changed).toEqual([CALLER.id]);
  });

  it('answers what the home service made the tree into', async () => {
    const { home, router } = await setUp();
    home.home.mockImplementation(async (made) => ({ ...made, projectIds: [`project-${made.id}`] }));
    const answer = await post(router, '/', { name: 'Shop', type: 'odoo-addons' });
    const made = answer.body as Tree;
    expect(made.projectIds).toEqual([`project-${made.id}`]);
  });

  it('refuses a body without a name or type, and a type that does not exist, listing the types there are', async () => {
    const { router } = await setUp();
    expect(await post(router, '/', { name: 'x' })).toEqual({ status: 400, body: { error: 'name and type are required' } });
    const unknown = await post(router, '/', { name: 'x', type: 'nonsense' });
    expect(unknown.status).toBe(400);
    const body = unknown.body as { error: string; available: { id: string; label: string }[] };
    expect(body.error).toBe('There is no project type "nonsense".');
    expect(body.available).toContainEqual({ id: 'api-service', label: 'API / service' });
  });

  it('makes it in the type\'s default version unless it asks for one the type offers, and refuses one it does not', async () => {
    const { db, router } = await setUp();
    expect((await post(router, '/', { name: 'Shop', type: 'odoo-addons' })).body).toMatchObject({ version: '20' });
    expect((await post(router, '/', { name: 'Shop', type: 'odoo-addons', version: '18' })).body).toMatchObject({ version: '18' });
    expect(await post(router, '/', { name: 'Shop', type: 'odoo-addons', version: '19' })).toEqual({ status: 400, body: { error: 'Odoo 19 is not offered; choose 20 or 18.' } });
    expect((await post(router, '/', { name: 'Shop', type: 'api-service', version: '20' })).status).toBe(400);
    expect((await db.projects.getTrees()).map((made) => made.version).sort()).toEqual(['18', '20']);
  });

  it('makes no tree when it cannot be given its project, says why and tells nobody', async () => {
    const { db, home, changed, router } = await setUp();
    home.home.mockRejectedValue(new Error('Gitea is down'));
    expect(await post(router, '/', { name: 'Shop', type: 'odoo-addons' })).toEqual({ status: 502, body: { error: 'The tree could not be given its project, so it was not made: Gitea is down' } });
    expect(await db.projects.getTrees()).toEqual([]);
    expect(changed).toEqual([]);
  });
});

describe('running a tree', () => {
  const status: GroveRunStatus = { state: 'running', startedAt: 'then' };

  it('reads the run\'s status as the caller', async () => {
    const { runs, router } = await setUp();
    runs.status.calledWith(CALLER.id, 't1').mockResolvedValue({ ok: true, value: status });
    runs.status.calledWith(CALLER.id, 't2').mockResolvedValue({ ok: false, status: 404, error: 'Tree not found' });
    expect(await get(router, '/t1/run')).toEqual({ status: 200, body: status });
    expect(await get(router, '/t2/run')).toEqual({ status: 404, body: { error: 'Tree not found' } });
  });

  it('answers 202 with the status once it has started, and passes on a refusal', async () => {
    const { runs, router } = await setUp();
    runs.run.calledWith(CALLER.id, 't1').mockResolvedValue({ ok: true, value: status });
    runs.run.calledWith(CALLER.id, 't2').mockResolvedValue({ ok: false, status: 409, error: 'Nothing is planned in this tree yet' });
    expect(await post(router, '/t1/run')).toEqual({ status: 202, body: status });
    expect(await post(router, '/t2/run')).toEqual({ status: 409, body: { error: 'Nothing is planned in this tree yet' } });
  });

  it('answers 202 when stopping and passes on a refusal', async () => {
    const { runs, router } = await setUp();
    runs.stop.calledWith(CALLER.id, 't1').mockResolvedValue({ ok: true, value: { state: 'none' } });
    runs.stop.calledWith(CALLER.id, 't2').mockResolvedValue({ ok: false, status: 409, error: 'The tree is not running.' });
    expect(await post(router, '/t1/run/stop')).toEqual({ status: 202, body: { state: 'none' } });
    expect(await post(router, '/t2/run/stop')).toEqual({ status: 409, body: { error: 'The tree is not running.' } });
  });
});

describe('a tree\'s models', () => {
  it('reads them and passes the body on whole when setting one', async () => {
    const { models, router } = await setUp();
    models.view.calledWith(CALLER.id, 't1').mockResolvedValue({ ok: true, value: { rows: [] } });
    models.set.mockResolvedValue({ ok: true, value: { rows: [] } });
    expect(await get(router, '/t1/models')).toEqual({ status: 200, body: { rows: [] } });
    expect(await put(router, '/t1/models', { agent: 'executor', modelId: 'tabby' })).toEqual({ status: 200, body: { rows: [] } });
    expect(models.set).toHaveBeenCalledWith(CALLER.id, 't1', { agent: 'executor', modelId: 'tabby' });
  });

  it('passes on a refusal when reading or setting', async () => {
    const { models, router } = await setUp();
    models.view.mockResolvedValue({ ok: false, status: 404, error: 'Tree not found' });
    models.set.mockResolvedValue({ ok: false, status: 400, error: 'There is no model nope among yours' });
    expect(await get(router, '/t9/models')).toEqual({ status: 404, body: { error: 'Tree not found' } });
    expect(await put(router, '/t1/models', { agent: 'executor', modelId: 'nope' })).toEqual({ status: 400, body: { error: 'There is no model nope among yours' } });
  });
});

describe('ordering a tree\'s features', () => {
  it('hands the order in the body to the order service and answers what it did', async () => {
    const { order, router } = await setUp();
    order.orderFeatures.mockResolvedValueOnce({ ok: true, value: { ordered: 2 } });
    expect(await put(router, '/t1/order', { branchIds: ['b2', 'b1'] })).toEqual({ status: 200, body: { ordered: 2 } });
    expect(order.orderFeatures).toHaveBeenCalledWith(CALLER.id, 't1', ['b2', 'b1']);
    order.orderFeatures.mockResolvedValueOnce({ ok: false, status: 400, error: 'bx is not among the features here' });
    expect(await put(router, '/t1/order', { branchIds: ['bx'] })).toEqual({ status: 400, body: { error: 'bx is not among the features here' } });
  });
});

describe('a tree\'s workspace', () => {
  it('reports the state of the sandbox of the caller\'s tree and never of another\'s', async () => {
    const { db, workspaces, router } = await setUp();
    workspaces.state.calledWith('t1').mockResolvedValue('parked');
    await db.projects.saveTree(tree());
    await db.projects.saveTree(tree({ id: 't2', ownerId: 'someone-else' }));
    expect(await get(router, '/t1/workspace')).toEqual({ status: 200, body: { state: 'parked' } });
    expect(await get(router, '/t2/workspace')).toEqual({ status: 404, body: { error: 'Tree not found' } });
  });

  it('releases the sandbox of the caller\'s tree and never of another\'s', async () => {
    const { db, workspaces, router } = await setUp();
    await db.projects.saveTree(tree());
    await db.projects.saveTree(tree({ id: 't2', ownerId: 'someone-else' }));
    expect(await del(router, '/t1/workspace')).toEqual({ status: 200, body: { state: 'none' } });
    expect(await del(router, '/t2/workspace')).toEqual({ status: 404, body: { error: 'Tree not found' } });
    expect(workspaces.release).toHaveBeenCalledTimes(1);
    expect(workspaces.release).toHaveBeenCalledWith('t1', CALLER.id);
  });
});

describe('a tree\'s workspace file', () => {
  const view = { path: '.koala/workspace.json', file: {} } as unknown as TreeWorkspaceView;

  it('is read for the owner and 404s for a tree that is not theirs', async () => {
    const { workspaceFile, router } = await setUp();
    workspaceFile.view.calledWith(CALLER.id, 't1').mockResolvedValue(view);
    expect(await get(router, '/t1/workspace-file')).toEqual({ status: 200, body: view });
    expect(await get(router, '/t9/workspace-file')).toEqual({ status: 404, body: { error: 'Tree not found' } });
  });

  it('is saved with the words said, or edited in the Studio when none were', async () => {
    const { workspaceFile, router } = await setUp();
    workspaceFile.save.mockResolvedValue({ ok: true, view, committed: true, build: { started: true, runId: 'workspace-build-t1-abc' } });
    const answer = await put(router, '/t1/workspace-file', { file: { packages: { pip: ['cowsay'] } }, said: '  added cowsay ' });
    expect(answer).toEqual({ status: 200, body: { ...view, committed: true, build: { started: true, runId: 'workspace-build-t1-abc' } } });
    expect(workspaceFile.save).toHaveBeenLastCalledWith(CALLER.id, 't1', { packages: { pip: ['cowsay'] } }, 'added cowsay');
    await put(router, '/t1/workspace-file', { file: {}, said: 5 });
    expect(workspaceFile.save).toHaveBeenLastCalledWith(CALLER.id, 't1', {}, 'edited in the Studio');
  });

  it('leaves the build out of the answer when none started, and passes a refusal on with its words', async () => {
    const { workspaceFile, router } = await setUp();
    workspaceFile.save.mockResolvedValueOnce({ ok: true, view, committed: false });
    expect((await put(router, '/t1/workspace-file', { file: {} })).body).toEqual({ ...view, committed: false });
    workspaceFile.save.mockResolvedValueOnce({ ok: false, status: 400, why: 'DB_PASSWORD looks like a secret' });
    expect(await put(router, '/t1/workspace-file', { file: {} })).toEqual({ status: 400, body: { error: 'DB_PASSWORD looks like a secret' } });
  });

  it('answers 503 when this server has no workspace file service', async () => {
    const { router } = await setUp({ withFile: false });
    expect((await get(router, '/t1/workspace-file')).status).toBe(503);
    expect((await put(router, '/t1/workspace-file', { file: {} })).status).toBe(503);
  });
});

describe('a tree\'s pull requests', () => {
  const pull: TreePullRequest = { number: 4, title: 'Add a thing', head: 'story-1', base: 'main', state: 'open', merged: false };

  it('lists them from the landings for the caller\'s tree', async () => {
    const asked: string[] = [];
    const { db, router } = await setUp({ landings: { pullRequests: async (ownerId, treeId) => { asked.push(`${ownerId} ${treeId}`); return [pull]; } } });
    await db.projects.saveTree(tree());
    expect(await get(router, '/t1/pull-requests')).toEqual({ status: 200, body: { pullRequests: [pull] } });
    expect(asked).toEqual([`${CALLER.id} t1`]);
  });

  it('lists none when the server has no landings, and 404s a tree that is not the caller\'s', async () => {
    const { db, router } = await setUp();
    await db.projects.saveTree(tree());
    await db.projects.saveTree(tree({ id: 't2', ownerId: 'someone-else' }));
    expect(await get(router, '/t1/pull-requests')).toEqual({ status: 200, body: { pullRequests: [] } });
    expect(await get(router, '/t2/pull-requests')).toEqual({ status: 404, body: { error: 'Tree not found' } });
  });
});

describe('deleting a tree', () => {
  it('reports what went and tells the owner\'s browsers', async () => {
    const { deletion, changed, router } = await setUp();
    const scope = { treeId: 't1', branchIds: ['b1'], leafIds: [], taskIds: [], proposalIds: [], adoptingProposalIds: [], conversationIds: [] };
    deletion.deleteTree.calledWith(CALLER.id, 't1').mockResolvedValue({ ok: true, value: { scope, stoppedRun: true } });
    expect(await del(router, '/t1')).toEqual({ status: 200, body: { success: true, stoppedRun: true, deleted: scope } });
    expect(changed).toEqual([CALLER.id]);
  });

  it('answers 404 for a tree that is not the caller\'s and tells nobody', async () => {
    const { deletion, changed, router } = await setUp();
    deletion.deleteTree.mockResolvedValue({ ok: false, status: 404, error: 'Tree not found' });
    expect(await del(router, '/t2')).toEqual({ status: 404, body: { error: 'Tree not found' } });
    expect(changed).toEqual([]);
  });
});
