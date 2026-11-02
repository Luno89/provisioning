import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { CALLER, del, get, put } from '../testing/route-call.js';
import type { Branch } from '../lib/leaves.js';
import type { GroveDeletionService } from '../services/GroveDeletionService.js';
import type { GroveOrderService } from '../services/GroveOrderService.js';
import { branchesRouter } from './branches.js';

const branch = (over: Partial<Branch> = {}): Branch => ({ id: 'b1', ownerId: CALLER.id, treeId: 't1', title: 'mine', createdAt: 't', updatedAt: 't', ...over });

function setUp() {
  const db = memoryDatabase();
  const deletion = mock<GroveDeletionService>();
  const order = mock<GroveOrderService>();
  return { db, deletion, order, router: branchesRouter({ db: db.projects, deletion, order }) };
}

describe('listing branches', () => {
  it('shows only the caller\'s own, most recently updated first', async () => {
    const { db, router } = setUp();
    await db.projects.saveBranch(branch({ id: 'old', updatedAt: '2026-01-01' }));
    await db.projects.saveBranch(branch({ id: 'new', updatedAt: '2026-02-01' }));
    await db.projects.saveBranch(branch({ id: 'theirs', ownerId: 'someone-else', updatedAt: '2026-03-01' }));
    expect(((await get(router, '/')).body as Branch[]).map((entry) => entry.id)).toEqual(['new', 'old']);
  });
});

describe('ordering a feature\'s stories', () => {
  it('hands the caller, the feature and the order in the body to the order service and answers what it did', async () => {
    const { order, router } = setUp();
    order.orderStories.mockResolvedValue({ ok: true, value: { ordered: 2 } });
    expect(await put(router, '/b1/order', { leafIds: ['l3', 'l1'] })).toEqual({ status: 200, body: { ordered: 2 } });
    expect(order.orderStories).toHaveBeenCalledWith(CALLER.id, 'b1', ['l3', 'l1']);
  });

  it('answers a refusal with its status and words', async () => {
    const { order, router } = setUp();
    order.orderStories.mockResolvedValue({ ok: false, status: 400, error: 'a story appears twice in the order' });
    expect(await put(router, '/b1/order', { leafIds: ['l1', 'l1'] })).toEqual({ status: 400, body: { error: 'a story appears twice in the order' } });
    order.orderStories.mockResolvedValue({ ok: false, status: 404, error: 'Feature not found' });
    expect(await put(router, '/b9/order', {})).toEqual({ status: 404, body: { error: 'Feature not found' } });
  });
});

describe('deleting a feature', () => {
  it('reports whether a run was stopped and what went', async () => {
    const { deletion, router } = setUp();
    const scope = { branchIds: ['b1'], leafIds: ['l1'], taskIds: [], proposalIds: [], adoptingProposalIds: [], conversationIds: [] };
    deletion.deleteBranch.calledWith(CALLER.id, 'b1').mockResolvedValue({ ok: true, value: { scope, stoppedRun: false } });
    expect(await del(router, '/b1')).toEqual({ status: 200, body: { success: true, stoppedRun: false, deleted: scope } });
  });

  it('answers 404 when the service cannot find the feature among the caller\'s', async () => {
    const { deletion, router } = setUp();
    deletion.deleteBranch.mockResolvedValue({ ok: false, status: 404, error: 'Branch not found' });
    expect(await del(router, '/b2')).toEqual({ status: 404, body: { error: 'Branch not found' } });
  });
});
