import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { PendingApprovalMetadata } from '../../platform/index.js';
import { pendingApprovalsRouter } from './pending-approvals.js';
import { callRouter, PERSON } from '../testing/call-router.js';

const approval = (id: string, createdAt: string, extra: Partial<PendingApprovalMetadata> = {}): PendingApprovalMetadata =>
  ({ id, ownerId: PERSON.id, status: 'pending', createdAt, ...extra }) as PendingApprovalMetadata;

describe('/api/pending-approvals', () => {
  it('lists only the person\'s own pending approvals, oldest first', async () => {
    const db = memoryDatabase();
    await db.infrastructure.savePendingApproval(approval('later', '2026-01-02'));
    await db.infrastructure.savePendingApproval(approval('earlier', '2026-01-01'));
    await db.infrastructure.savePendingApproval(approval('decided', '2026-01-01', { status: 'approved' }));
    await db.infrastructure.savePendingApproval(approval('theirs', '2026-01-01', { ownerId: 'someone-else' }));
    const answer = await callRouter(pendingApprovalsRouter({ db }), '/api/pending-approvals', {});
    expect((answer.body as { id: string }[]).map((row) => row.id)).toEqual(['earlier', 'later']);
  });

  it('records the decision on an approval of the person\'s, once', async () => {
    const db = memoryDatabase();
    await db.infrastructure.savePendingApproval(approval('a1', '2026-01-01'));
    const router = pendingApprovalsRouter({ db });
    expect((await callRouter(router, '/api/pending-approvals', { method: 'POST', path: '/a1/decide', body: { decision: 'denied' } })).body).toEqual({ success: true });
    expect((await db.infrastructure.getPendingApprovals()).find((row) => row.id === 'a1')).toMatchObject({ status: 'denied' });
    expect((await callRouter(router, '/api/pending-approvals', { method: 'POST', path: '/a1/decide', body: { decision: 'approved' } })).status).toBe(409);
  });

  it('refuses a decision that is neither approved nor denied, and an approval that is not the person\'s', async () => {
    const db = memoryDatabase();
    await db.infrastructure.savePendingApproval(approval('theirs', '2026-01-01', { ownerId: 'someone-else' }));
    const router = pendingApprovalsRouter({ db });
    expect((await callRouter(router, '/api/pending-approvals', { method: 'POST', path: '/theirs/decide', body: { decision: 'maybe' } })).status).toBe(400);
    expect((await callRouter(router, '/api/pending-approvals', { method: 'POST', path: '/theirs/decide', body: { decision: 'approved' } })).status).toBe(404);
  });
});
