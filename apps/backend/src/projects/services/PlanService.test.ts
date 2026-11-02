import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { PlanProposal } from '../lib/plan-proposals.js';
import type { StoryNow } from '../lib/plan-staleness.js';
import { PlanService, type PlanAdopter } from './PlanService.js';

const proposal = (over: Partial<PlanProposal> = {}): PlanProposal => ({
  id: 'p1', ownerId: 'ann', conversationId: 'conv-1', status: 'proposed',
  plan: { tree: { name: 'Widget', type: 'api-service' }, planDoc: '# Widget', branches: [{ title: 'B', leaves: [] }] },
  createdAt: '2026-01-01', updatedAt: '2026-01-01', ...over,
});
const leafPlan = (leafId: string, treeId = 't9'): PlanProposal['leafPlan'] => ({ treeId, leafId, leafTitle: 'The sandbox facts', mode: 'replan', why: 'w', brief: 'b', tasks: [] });

function setUp(stories?: StoryNow[]) {
  const db = memoryDatabase();
  const adopter = mock<PlanAdopter>();
  adopter.adoptPlan.mockImplementation(async (_ownerId, id) => `adopt-plan-${id}`);
  const settled: [string, string | undefined][] = [];
  const service = new PlanService({
    store: db.projects, adopter, now: () => 'now',
    ...(stories ? { stories: async () => stories } : {}),
    onSettled: (ownerId, conversationId) => { settled.push([ownerId, conversationId]); },
  });
  return { db, adopter, settled, service };
}

describe('listing plans', () => {
  it('lists a conversation\'s plans and only the caller\'s', async () => {
    const { db, service } = setUp();
    await db.projects.savePlanProposal(proposal());
    await db.projects.savePlanProposal(proposal({ id: 'p2', conversationId: 'conv-2' }));
    await db.projects.savePlanProposal(proposal({ id: 'p3', ownerId: 'bo' }));
    expect((await service.list('ann', 'conv-1')).map((entry) => entry.id)).toEqual(['p1']);
    expect((await service.list('ann')).map((entry) => entry.id)).toEqual(['p1', 'p2']);
  });

  it('lists a tree\'s proposals: the plan that grew it and the leaf plans and changes for its stories', async () => {
    const { db, service } = setUp();
    await db.projects.savePlanProposal(proposal({ id: 'grew', status: 'adopted', adopted: { treeId: 't9', branchIds: [], leafIds: {}, taskIds: {} } }));
    await db.projects.savePlanProposal(proposal({ id: 'replan', plan: undefined, leafPlan: leafPlan('l1') }));
    await db.projects.savePlanProposal(proposal({ id: 'elsewhere', plan: undefined, leafPlan: leafPlan('l2', 't8') }));
    expect((await service.forTree('ann', 't9')).map((entry) => entry.id).sort()).toEqual(['grew', 'replan']);
  });

  it('reads one plan of the caller\'s and none of another\'s', async () => {
    const { db, service } = setUp();
    await db.projects.savePlanProposal(proposal());
    await db.projects.savePlanProposal(proposal({ id: 'p3', ownerId: 'bo' }));
    expect((await service.get('ann', 'p1'))?.id).toBe('p1');
    expect(await service.get('ann', 'p3')).toBeUndefined();
  });
});

describe('plans about stories that have moved on', () => {
  const finished: StoryNow[] = [{ id: 'l1', title: 'The sandbox facts', status: 'succeeded' }];
  const why = 'out of date: "The sandbox facts" has succeeded since this was proposed';

  it('are shown as replaced, and saved so, when listed', async () => {
    const { db, service } = setUp(finished);
    await db.projects.savePlanProposal(proposal({ id: 'old', plan: undefined, leafPlan: leafPlan('l1') }));
    await db.projects.savePlanProposal(proposal({ id: 'fine', plan: undefined, leafPlan: leafPlan('l1'), status: 'adopted' }));
    const listed = await service.forTree('ann', 't9');
    expect(listed.map((entry) => [entry.id, entry.status, entry.reason])).toEqual([['old', 'superseded', why], ['fine', 'adopted', undefined]]);
    expect((await db.projects.getPlanProposal('ann', 'old'))?.status).toBe('superseded');
  });

  it('are refused when approved, with nothing adopted', async () => {
    const { db, adopter, service } = setUp(finished);
    await db.projects.savePlanProposal(proposal({ id: 'old', plan: undefined, leafPlan: leafPlan('l1') }));
    expect(await service.approve('ann', 'old')).toEqual({ ok: false, status: 409, error: `This card is ${why}. Nothing was changed.` });
    expect(adopter.adoptPlan).not.toHaveBeenCalled();
  });

  it('are left alone when no story reader is given or the plan is not about a story', async () => {
    const { db, service } = setUp();
    await db.projects.savePlanProposal(proposal({ id: 'old', plan: undefined, leafPlan: leafPlan('l1') }));
    expect((await service.list('ann'))[0]?.status).toBe('proposed');
    const withReader = setUp(finished);
    await withReader.db.projects.savePlanProposal(proposal());
    expect((await withReader.service.list('ann'))[0]?.status).toBe('proposed');
  });

  it('are marked gone when their story is', async () => {
    const { db, service } = setUp([]);
    await db.projects.savePlanProposal(proposal({ id: 'old', plan: undefined, leafPlan: leafPlan('l1') }));
    expect((await service.list('ann'))[0]).toMatchObject({ status: 'superseded', reason: 'out of date: the story "The sandbox facts" is gone' });
  });
});

describe('approving a plan', () => {
  it('starts the adoption, marks the plan adopting and says it was settled in its conversation', async () => {
    const { db, adopter, settled, service } = setUp();
    await db.projects.savePlanProposal(proposal({ reason: 'earlier trouble' }));
    const decided = await service.approve('ann', 'p1');
    expect(decided).toMatchObject({ ok: true, proposal: { status: 'adopting', updatedAt: 'now' } });
    expect(decided.ok && decided.proposal.reason).toBeUndefined();
    expect(adopter.adoptPlan).toHaveBeenCalledWith('ann', 'p1');
    expect((await db.projects.getPlanProposal('ann', 'p1'))?.status).toBe('adopting');
    expect(settled).toEqual([['ann', 'conv-1']]);
  });

  it('lets a failed adoption be approved again, but not an adopted or rejected plan', async () => {
    const { db, service } = setUp();
    await db.projects.savePlanProposal(proposal({ status: 'failed', reason: 'the sandbox would not start' }));
    await db.projects.savePlanProposal(proposal({ id: 'p2', status: 'adopted' }));
    await db.projects.savePlanProposal(proposal({ id: 'p3', status: 'rejected' }));
    expect((await service.approve('ann', 'p1')).ok).toBe(true);
    expect(await service.approve('ann', 'p2')).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('This plan is adopted') as unknown as string });
    expect(await service.approve('ann', 'p3')).toMatchObject({ ok: false, status: 409 });
  });

  it('puts the plan back as it was and settles nothing when the adoption cannot start', async () => {
    const { db, adopter, settled, service } = setUp();
    await db.projects.savePlanProposal(proposal());
    adopter.adoptPlan.mockResolvedValueOnce(undefined);
    expect(await service.approve('ann', 'p1')).toEqual({ ok: false, status: 503, error: 'Temporal is not reachable, so the plan could not be built. It is still waiting for approval.' });
    expect((await db.projects.getPlanProposal('ann', 'p1'))?.status).toBe('proposed');
    adopter.adoptPlan.mockRejectedValueOnce(new Error('no worker'));
    expect(await service.approve('ann', 'p1')).toEqual({ ok: false, status: 503, error: 'The plan could not be built: no worker. It is still waiting for approval.' });
    expect((await db.projects.getPlanProposal('ann', 'p1'))?.status).toBe('proposed');
    expect(settled).toEqual([]);
  });

  it('404s a plan that is not the caller\'s', async () => {
    const { db, service } = setUp();
    await db.projects.savePlanProposal(proposal({ ownerId: 'bo' }));
    expect(await service.approve('ann', 'p1')).toEqual({ ok: false, status: 404, error: 'Plan not found' });
  });
});

describe('rejecting a plan', () => {
  it('records the trimmed reason given', async () => {
    const { db, adopter, service } = setUp();
    await db.projects.savePlanProposal(proposal());
    expect(await service.reject('ann', 'p1', '  split the deploy leaf ')).toMatchObject({ ok: true, proposal: { status: 'rejected', reason: 'split the deploy leaf', updatedAt: 'now' } });
    expect((await db.projects.getPlanProposal('ann', 'p1'))?.status).toBe('rejected');
    expect(adopter.adoptPlan).not.toHaveBeenCalled();
  });

  it('records no reason when none or a blank one is given', async () => {
    const { db, service } = setUp();
    await db.projects.savePlanProposal(proposal());
    const decided = await service.reject('ann', 'p1', '   ');
    expect(decided.ok && decided.proposal.reason).toBeUndefined();
  });

  it('refuses a plan already decided and 404s one that is not the caller\'s', async () => {
    const { db, service } = setUp();
    await db.projects.savePlanProposal(proposal({ status: 'adopted' }));
    await db.projects.savePlanProposal(proposal({ id: 'p3', ownerId: 'bo' }));
    expect(await service.reject('ann', 'p1')).toEqual({ ok: false, status: 409, error: 'This plan is adopted; it can no longer be rejected.' });
    expect(await service.reject('ann', 'p3')).toEqual({ ok: false, status: 404, error: 'Plan not found' });
  });
});
