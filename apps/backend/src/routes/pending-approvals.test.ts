import { describe, it, expect, afterAll } from 'vitest';
import { pendingApprovalsRouter } from './pending-approvals.js';
import { mountRouter, type Harness, TEST_USER } from './test-harness.js';
import type { Database } from '../lib/db-interface.js';

const harness: Harness = await mountRouter({
  prefix: '/api/pending-approvals',
  router: (db: Database) => pendingApprovalsRouter({ db }),
});

afterAll(async () => { await harness.close(); });

describe('GET /api/pending-approvals', () => {
  it('lists only the requesting user\'s own pending approvals', async () => {
    await harness.db.savePendingApproval({
      id: 'a-mine', ownerId: TEST_USER.id, leafId: 'leaf-1', command: 'ls',
      status: 'pending', createdAt: '2026-01-01T00:00:00Z',
    });
    await harness.db.savePendingApproval({
      id: 'a-theirs', ownerId: 'someone-else', leafId: 'leaf-2', command: 'ls',
      status: 'pending', createdAt: '2026-01-01T00:00:00Z',
    });
    await harness.db.savePendingApproval({
      id: 'a-decided', ownerId: TEST_USER.id, leafId: 'leaf-3', command: 'ls',
      status: 'approved', createdAt: '2026-01-01T00:00:00Z',
    });

    const res = await fetch(harness.url('/api/pending-approvals'));
    const body = await res.json() as any[];

    expect(body.map((a) => a.id)).toEqual(['a-mine']);
  });
});

describe('POST /api/pending-approvals/:id/decide', () => {
  it('approves a pending request the user owns', async () => {
    await harness.db.savePendingApproval({
      id: 'a-approve', ownerId: TEST_USER.id, leafId: 'leaf-1', command: 'ls',
      status: 'pending', createdAt: '2026-01-01T00:00:00Z',
    });

    const res = await fetch(harness.url('/api/pending-approvals/a-approve/decide'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(res.status).toBe(200);

    const [row] = (await harness.db.getPendingApprovals()).filter((a) => a.id === 'a-approve');
    expect(row!.status).toBe('approved');
    expect(row!.decidedAt).toBeTruthy();
  });

  it('denies a pending request the user owns', async () => {
    await harness.db.savePendingApproval({
      id: 'a-deny', ownerId: TEST_USER.id, leafId: 'leaf-1', command: 'rm -rf /',
      status: 'pending', createdAt: '2026-01-01T00:00:00Z',
    });

    const res = await fetch(harness.url('/api/pending-approvals/a-deny/decide'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'denied' }),
    });
    expect(res.status).toBe(200);

    const [row] = (await harness.db.getPendingApprovals()).filter((a) => a.id === 'a-deny');
    expect(row!.status).toBe('denied');
  });

  it('rejects an invalid decision value', async () => {
    await harness.db.savePendingApproval({
      id: 'a-bad', ownerId: TEST_USER.id, leafId: 'leaf-1', command: 'ls',
      status: 'pending', createdAt: '2026-01-01T00:00:00Z',
    });

    const res = await fetch(harness.url('/api/pending-approvals/a-bad/decide'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses to decide a request belonging to someone else', async () => {
    await harness.db.savePendingApproval({
      id: 'a-not-mine', ownerId: 'someone-else', leafId: 'leaf-1', command: 'ls',
      status: 'pending', createdAt: '2026-01-01T00:00:00Z',
    });

    const res = await fetch(harness.url('/api/pending-approvals/a-not-mine/decide'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(res.status).toBe(404);

    const [row] = (await harness.db.getPendingApprovals()).filter((a) => a.id === 'a-not-mine');
    expect(row!.status).toBe('pending');
  });

  it('refuses to re-decide an already-decided request', async () => {
    await harness.db.savePendingApproval({
      id: 'a-already', ownerId: TEST_USER.id, leafId: 'leaf-1', command: 'ls',
      status: 'approved', createdAt: '2026-01-01T00:00:00Z', decidedAt: '2026-01-01T00:05:00Z',
    });

    const res = await fetch(harness.url('/api/pending-approvals/a-already/decide'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'denied' }),
    });
    expect(res.status).toBe(409);
  });
});
