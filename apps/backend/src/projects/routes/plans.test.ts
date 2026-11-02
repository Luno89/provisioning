import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { PlanProposal } from '../lib/plan-proposals.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type RouteAnswer } from '../../platform/testing/routes.js';
import type { PlanService } from '../services/PlanService.js';
import { plansRouter } from './plans.js';

const proposal = (over: Partial<PlanProposal> = {}): PlanProposal => ({ id: 'p1', ownerId: TEST_USER.id, status: 'proposed', createdAt: 't', updatedAt: 't', ...over });

const plain = ({ status, data }: RouteAnswer) => ({ status, body: data });

async function setUp() {
  const plans = mock<PlanService>();
  const routes = await routesInProcess({ prefix: '/', router: () => plansRouter({ plans }) });
  return { plans, routes };
}

describe('listing plans', () => {
  it('lists a tree\'s plans when a tree is named', async () => {
    const { plans, routes } = await setUp();
    plans.forTree.calledWith(TEST_USER.id, 't1').mockResolvedValue([proposal()]);
    expect(await routes.get('/?treeId=t1')).toMatchObject({ status: 200, data: [{ id: 'p1' }] });
    expect(plans.list).not.toHaveBeenCalled();
  });

  it('lists a conversation\'s plans, or all of the person\'s, when no tree is named', async () => {
    const { plans, routes } = await setUp();
    plans.list.calledWith(TEST_USER.id, 'c1').mockResolvedValue([proposal({ id: 'in-c1' })]);
    plans.list.calledWith(TEST_USER.id, undefined).mockResolvedValue([proposal({ id: 'a' }), proposal({ id: 'b' })]);
    expect(((await routes.get('/?conversationId=c1')).data as PlanProposal[]).map((entry) => entry.id)).toEqual(['in-c1']);
    expect(((await routes.get('/')).data as PlanProposal[]).map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});

describe('reading one plan', () => {
  it('answers it, or 404 when the caller has none by that id', async () => {
    const { plans, routes } = await setUp();
    plans.get.calledWith(TEST_USER.id, 'p1').mockResolvedValue(proposal());
    expect(await routes.get('/p1')).toMatchObject({ status: 200, data: { id: 'p1' } });
    expect(plain(await routes.get('/p9'))).toEqual({ status: 404, body: { error: 'Plan not found' } });
  });
});

describe('deciding a plan', () => {
  it('answers 202 with the plan once approval has started building it', async () => {
    const { plans, routes } = await setUp();
    plans.approve.calledWith(TEST_USER.id, 'p1').mockResolvedValue({ ok: true, proposal: proposal({ status: 'adopting' }) });
    expect(await routes.post('/p1/approve')).toMatchObject({ status: 202, data: { status: 'adopting' } });
  });

  it('answers an approval the service refuses with its status and words', async () => {
    const { plans, routes } = await setUp();
    plans.approve.mockResolvedValue({ ok: false, status: 503, error: 'Temporal is not reachable' });
    expect(plain(await routes.post('/p1/approve'))).toEqual({ status: 503, body: { error: 'Temporal is not reachable' } });
  });

  it('passes a text reason on when rejecting and drops any other kind', async () => {
    const { plans, routes } = await setUp();
    plans.reject.mockResolvedValue({ ok: true, proposal: proposal({ status: 'rejected' }) });
    expect(await routes.post('/p1/reject', { reason: 'too big' })).toMatchObject({ status: 200, data: { status: 'rejected' } });
    expect(plans.reject).toHaveBeenLastCalledWith(TEST_USER.id, 'p1', 'too big');
    await routes.post('/p1/reject', { reason: 7 });
    expect(plans.reject).toHaveBeenLastCalledWith(TEST_USER.id, 'p1', undefined);
    plans.reject.mockResolvedValue({ ok: false, status: 409, error: 'it can no longer be rejected' });
    expect(plain(await routes.post('/p1/reject', {}))).toEqual({ status: 409, body: { error: 'it can no longer be rejected' } });
  });
});
