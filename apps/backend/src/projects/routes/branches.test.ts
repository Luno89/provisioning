import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type RouteAnswer } from '../../platform/testing/routes.js';
import type { Branch } from '../lib/leaves.js';
import type { GroveDeletionService } from '../services/GroveDeletionService.js';
import type { GroveOrderService } from '../services/GroveOrderService.js';
import { branchesRouter } from './branches.js';

const branch = (over: Partial<Branch> = {}): Branch => ({ id: 'b1', ownerId: TEST_USER.id, treeId: 't1', title: 'mine', createdAt: 't', updatedAt: 't', ...over });

const plain = ({ status, data }: RouteAnswer) => ({ status, body: data });

async function setUp() {
  const db = memoryDatabase();
  const deletion = mock<GroveDeletionService>();
  const order = mock<GroveOrderService>();
  const routes = await routesInProcess({ prefix: '/', router: () => branchesRouter({ db: db.projects, deletion, order }), db: db });
  return { db, deletion, order, routes };
}

describe('listing branches', () => {
  it('shows only the caller\'s own, most recently updated first', async () => {
    const { db, routes } = await setUp();
    await db.projects.saveBranch(branch({ id: 'old', updatedAt: '2026-01-01' }));
    await db.projects.saveBranch(branch({ id: 'new', updatedAt: '2026-02-01' }));
    await db.projects.saveBranch(branch({ id: 'theirs', ownerId: 'someone-else', updatedAt: '2026-03-01' }));
    expect(((await routes.get('/')).data as Branch[]).map((entry) => entry.id)).toEqual(['new', 'old']);
  });
});

describe('ordering a feature\'s stories', () => {
  it('hands the caller, the feature and the order in the body to the order service and answers what it did', async () => {
    const { order, routes } = await setUp();
    order.orderStories.mockResolvedValue({ ok: true, value: { ordered: 2 } });
    expect(plain(await routes.put('/b1/order', { leafIds: ['l3', 'l1'] }))).toEqual({ status: 200, body: { ordered: 2 } });
    expect(order.orderStories).toHaveBeenCalledWith(TEST_USER.id, 'b1', ['l3', 'l1']);
  });

  it('answers a refusal with its status and words', async () => {
    const { order, routes } = await setUp();
    order.orderStories.mockResolvedValue({ ok: false, status: 400, error: 'a story appears twice in the order' });
    expect(plain(await routes.put('/b1/order', { leafIds: ['l1', 'l1'] }))).toEqual({ status: 400, body: { error: 'a story appears twice in the order' } });
    order.orderStories.mockResolvedValue({ ok: false, status: 404, error: 'Feature not found' });
    expect(plain(await routes.put('/b9/order', {}))).toEqual({ status: 404, body: { error: 'Feature not found' } });
  });
});

describe('deleting a feature', () => {
  it('reports whether a run was stopped and what went', async () => {
    const { deletion, routes } = await setUp();
    const scope = { branchIds: ['b1'], leafIds: ['l1'], taskIds: [], proposalIds: [], adoptingProposalIds: [], conversationIds: [] };
    deletion.deleteBranch.calledWith(TEST_USER.id, 'b1').mockResolvedValue({ ok: true, value: { scope, stoppedRun: false } });
    expect(plain(await routes.delete('/b1'))).toEqual({ status: 200, body: { success: true, stoppedRun: false, deleted: scope } });
  });

  it('answers 404 when the service cannot find the feature among the caller\'s', async () => {
    const { deletion, routes } = await setUp();
    deletion.deleteBranch.mockResolvedValue({ ok: false, status: 404, error: 'Branch not found' });
    expect(plain(await routes.delete('/b2'))).toEqual({ status: 404, body: { error: 'Branch not found' } });
  });
});
