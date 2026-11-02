import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { PlanProposal } from '../lib/plan-proposals.js';
import { CALLER, get, post } from '../testing/route-call.js';
import type { PlanService } from '../services/PlanService.js';
import { plansRouter } from './plans.js';

const proposal = (over: Partial<PlanProposal> = {}): PlanProposal => ({ id: 'p1', ownerId: CALLER.id, status: 'proposed', createdAt: 't', updatedAt: 't', ...over });

function setUp() {
  const plans = mock<PlanService>();
  return { plans, router: plansRouter({ plans }) };
}

describe('listing plans', () => {
  it('lists a tree\'s plans when a tree is named', async () => {
    const { plans, router } = setUp();
    plans.forTree.calledWith(CALLER.id, 't1').mockResolvedValue([proposal()]);
    expect(await get(router, '/?treeId=t1')).toMatchObject({ status: 200, body: [{ id: 'p1' }] });
    expect(plans.list).not.toHaveBeenCalled();
  });

  it('lists a conversation\'s plans, or all of the person\'s, when no tree is named', async () => {
    const { plans, router } = setUp();
    plans.list.calledWith(CALLER.id, 'c1').mockResolvedValue([proposal({ id: 'in-c1' })]);
    plans.list.calledWith(CALLER.id, undefined).mockResolvedValue([proposal({ id: 'a' }), proposal({ id: 'b' })]);
    expect(((await get(router, '/?conversationId=c1')).body as PlanProposal[]).map((entry) => entry.id)).toEqual(['in-c1']);
    expect(((await get(router, '/')).body as PlanProposal[]).map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});

describe('reading one plan', () => {
  it('answers it, or 404 when the caller has none by that id', async () => {
    const { plans, router } = setUp();
    plans.get.calledWith(CALLER.id, 'p1').mockResolvedValue(proposal());
    expect(await get(router, '/p1')).toMatchObject({ status: 200, body: { id: 'p1' } });
    expect(await get(router, '/p9')).toEqual({ status: 404, body: { error: 'Plan not found' } });
  });
});

describe('deciding a plan', () => {
  it('answers 202 with the plan once approval has started building it', async () => {
    const { plans, router } = setUp();
    plans.approve.calledWith(CALLER.id, 'p1').mockResolvedValue({ ok: true, proposal: proposal({ status: 'adopting' }) });
    expect(await post(router, '/p1/approve')).toMatchObject({ status: 202, body: { status: 'adopting' } });
  });

  it('answers an approval the service refuses with its status and words', async () => {
    const { plans, router } = setUp();
    plans.approve.mockResolvedValue({ ok: false, status: 503, error: 'Temporal is not reachable' });
    expect(await post(router, '/p1/approve')).toEqual({ status: 503, body: { error: 'Temporal is not reachable' } });
  });

  it('passes a text reason on when rejecting and drops any other kind', async () => {
    const { plans, router } = setUp();
    plans.reject.mockResolvedValue({ ok: true, proposal: proposal({ status: 'rejected' }) });
    expect(await post(router, '/p1/reject', { reason: 'too big' })).toMatchObject({ status: 200, body: { status: 'rejected' } });
    expect(plans.reject).toHaveBeenLastCalledWith(CALLER.id, 'p1', 'too big');
    await post(router, '/p1/reject', { reason: 7 });
    expect(plans.reject).toHaveBeenLastCalledWith(CALLER.id, 'p1', undefined);
    plans.reject.mockResolvedValue({ ok: false, status: 409, error: 'it can no longer be rejected' });
    expect(await post(router, '/p1/reject', {})).toEqual({ status: 409, body: { error: 'it can no longer be rejected' } });
  });
});
