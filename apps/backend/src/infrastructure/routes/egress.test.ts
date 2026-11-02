import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { EgressGrantRecord, EgressRequest } from '@koala/harness-types';
import type { EgressService } from '../services/EgressService.js';
import { egressRouter } from './egress.js';
import { callRouter, PERSON } from '../testing/call-router.js';

const request = { id: 'r1', ownerId: PERSON.id, agentSlug: 'executor', host: 'example.com', why: 'docs', status: 'requested', createdAt: 'x', updatedAt: 'x' } as EgressRequest;
const grant = { id: 'g1', ownerId: PERSON.id, agentSlug: 'executor', host: 'example.com', reason: 'docs', approvedBy: PERSON.id, approvedAt: 'x' } as EgressGrantRecord;

describe('/api/egress', () => {
  it('lists the person\'s requests, narrowed by conversation and tree when named', async () => {
    const egress = mock<EgressService>();
    egress.requests.calledWith(PERSON.id, matches<{ conversationId?: string | undefined; treeId?: string | undefined }>((filter) => filter.conversationId === 'c1' && filter.treeId === 't1')).mockResolvedValue([request]);
    egress.requests.calledWith(PERSON.id, matches<{ conversationId?: string | undefined; treeId?: string | undefined }>((filter) => filter.conversationId === undefined && filter.treeId === undefined)).mockResolvedValue([]);
    const router = egressRouter({ egress });
    expect((await callRouter(router, '/api/egress', { path: '/requests?conversationId=c1&treeId=t1' })).body).toEqual([request]);
    expect((await callRouter(router, '/api/egress', { path: '/requests' })).body).toEqual([]);
  });

  it('lists the person\'s grants for the agent named', async () => {
    const egress = mock<EgressService>();
    egress.grants.calledWith(PERSON.id, 'executor').mockResolvedValue([grant]);
    expect((await callRouter(egressRouter({ egress }), '/api/egress', { path: '/grants?agent=executor' })).body).toEqual([grant]);
  });

  it('answers an allowed request with the request and the grant it made', async () => {
    const egress = mock<EgressService>();
    egress.allow.calledWith(PERSON.id, 'r1').mockResolvedValue({ ok: true, request: { ...request, status: 'allowed' }, grant });
    const answer = await callRouter(egressRouter({ egress }), '/api/egress', { method: 'POST', path: '/requests/r1/allow' });
    expect(answer.body).toEqual({ request: { ...request, status: 'allowed' }, grant });
  });

  it('answers a dismissed request with the request alone and a revoked grant with the grant alone', async () => {
    const egress = mock<EgressService>();
    egress.dismiss.mockResolvedValue({ ok: true, request: { ...request, status: 'dismissed' } });
    egress.revoke.mockResolvedValue({ ok: true, grant: { ...grant, revokedAt: 'y' } });
    const router = egressRouter({ egress });
    expect((await callRouter(router, '/api/egress', { method: 'POST', path: '/requests/r1/dismiss' })).body).toEqual({ request: { ...request, status: 'dismissed' } });
    expect((await callRouter(router, '/api/egress', { method: 'POST', path: '/grants/g1/revoke' })).body).toEqual({ grant: { ...grant, revokedAt: 'y' } });
  });

  it('answers the status and words the service refused with', async () => {
    const egress = mock<EgressService>();
    egress.allow.mockResolvedValue({ ok: false, status: 409, error: 'This request is already allowed.' });
    const answer = await callRouter(egressRouter({ egress }), '/api/egress', { method: 'POST', path: '/requests/r1/allow' });
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ error: 'This request is already allowed.' });
  });
});
