import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { plansRouter } from './plans.js';
import { PlanService } from '../services/PlanService.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import type { PlanProposal } from '../lib/plan-proposals.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const adopter = { adoptPlan: vi.fn(async (_ownerId: string, id: string): Promise<string | undefined> => `adopt-plan-${id}`) };

const mount = async (): Promise<Harness> => {
  adopter.adoptPlan.mockClear();
  h = await mountRouter({
    prefix: '/api/plans',
    router: (db) => plansRouter({ plans: new PlanService({ store: db, adopter, now: () => 'now' }) }),
  });
  return h!;
};

const proposal = (over: Partial<PlanProposal> = {}): PlanProposal => ({
  id: 'p1',
  ownerId: TEST_USER.id,
  conversationId: 'conv-1',
  status: 'proposed',
  plan: { tree: { name: 'Widget', type: 'api-service' }, planDoc: '# Widget', branches: [{ title: 'B', leaves: [] }] },
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  ...over,
});

const statusOf = async (call: Promise<unknown>) => (call.then(() => 200, (err: { response?: { status: number } }) => err.response?.status));

describe('/api/plans', () => {
  it('lists a conversation\'s plans, and only the caller\'s', async () => {
    const harness = await mount();
    await harness.db.savePlanProposal(proposal());
    await harness.db.savePlanProposal(proposal({ id: 'p2', conversationId: 'conv-2' }));
    await harness.db.savePlanProposal(proposal({ id: 'p3', ownerId: 'someone-else' }));

    const res = await axios.get(harness.url('/api/plans?conversationId=conv-1'));
    expect(res.data.map((entry: PlanProposal) => entry.id)).toEqual(['p1']);
    expect(await statusOf(axios.get(harness.url('/api/plans/p3')))).toBe(404);
  });

  it('approving starts the adoption and marks the plan adopting', async () => {
    const harness = await mount();
    await harness.db.savePlanProposal(proposal());

    const res = await axios.post(harness.url('/api/plans/p1/approve'));

    expect(res.status).toBe(202);
    expect(res.data.status).toBe('adopting');
    expect(adopter.adoptPlan).toHaveBeenCalledWith(TEST_USER.id, 'p1');
    expect((await harness.db.getPlanProposal(TEST_USER.id, 'p1'))?.status).toBe('adopting');
  });

  it('leaves the plan waiting when the adoption cannot start', async () => {
    const harness = await mount();
    await harness.db.savePlanProposal(proposal());
    adopter.adoptPlan.mockResolvedValueOnce(undefined);

    expect(await statusOf(axios.post(harness.url('/api/plans/p1/approve')))).toBe(503);
    expect((await harness.db.getPlanProposal(TEST_USER.id, 'p1'))?.status).toBe('proposed');
  });

  it('lets a failed adoption be approved again, but not an adopted or rejected plan', async () => {
    const harness = await mount();
    await harness.db.savePlanProposal(proposal({ status: 'failed', reason: 'the sandbox would not start' }));
    await harness.db.savePlanProposal(proposal({ id: 'p2', status: 'adopted' }));

    const retried = await axios.post(harness.url('/api/plans/p1/approve'));
    expect(retried.data).toMatchObject({ status: 'adopting' });
    expect(retried.data.reason).toBeUndefined();
    expect(await statusOf(axios.post(harness.url('/api/plans/p2/approve')))).toBe(409);
    expect(await statusOf(axios.post(harness.url('/api/plans/p2/reject')))).toBe(409);
  });

  it('rejects with the reason given, and never another owner\'s plan', async () => {
    const harness = await mount();
    await harness.db.savePlanProposal(proposal());
    await harness.db.savePlanProposal(proposal({ id: 'p3', ownerId: 'someone-else' }));

    const res = await axios.post(harness.url('/api/plans/p1/reject'), { reason: 'split the deploy leaf' });
    expect(res.data).toMatchObject({ status: 'rejected', reason: 'split the deploy leaf' });
    expect(await statusOf(axios.post(harness.url('/api/plans/p3/reject')))).toBe(404);
    expect(adopter.adoptPlan).not.toHaveBeenCalled();
  });
});
