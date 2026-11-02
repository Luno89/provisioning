import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { AccessRequest } from '@koala/harness-types';
import type { Principal } from '../../platform/index.js';
import type { AccessService } from '../services/AccessService.js';
import { clusterAccessRouter } from './cluster-access.js';
import { callRouter, PERSON } from '../testing/call-router.js';

const request = { id: 'q1', ownerId: PERSON.id, conversationId: 'c1', namespaces: ['monitoring'], why: 'prometheus', status: 'requested', createdAt: 'x', updatedAt: 'x' } as AccessRequest;

describe('/api/cluster-access', () => {
  it('lists the signed-in person\'s requests, narrowed to a conversation when one is named', async () => {
    const access = mock<AccessService>();
    access.list.calledWith(PERSON.id, undefined).mockResolvedValue([request]);
    access.list.calledWith(PERSON.id, 'c1').mockResolvedValue([]);
    const router = clusterAccessRouter({ access });
    expect((await callRouter(router, '/api/cluster-access', {})).body).toEqual([request]);
    expect((await callRouter(router, '/api/cluster-access', { path: '?conversationId=c1' })).body).toEqual([]);
  });

  it('grants as the person asking and answers with the decided request', async () => {
    const access = mock<AccessService>();
    access.grant.calledWith(matches<Principal>((who) => who.id === PERSON.id), 'q1').mockResolvedValue({ ok: true, request: { ...request, status: 'granted' } });
    const answer = await callRouter(clusterAccessRouter({ access }), '/api/cluster-access', { method: 'POST', path: '/q1/grant' });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: 'granted' });
  });

  it('answers the status and words the service refused a grant with', async () => {
    const access = mock<AccessService>();
    access.grant.mockResolvedValue({ ok: false, status: 403, error: 'only the operator opens platform namespaces' });
    const answer = await callRouter(clusterAccessRouter({ access }), '/api/cluster-access', { method: 'POST', path: '/q1/grant' });
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ error: 'only the operator opens platform namespaces' });
  });

  it('dismisses a request for the person asking', async () => {
    const access = mock<AccessService>();
    access.dismiss.calledWith(PERSON.id, 'q1').mockResolvedValue({ ok: true, request: { ...request, status: 'dismissed' } });
    const answer = await callRouter(clusterAccessRouter({ access }), '/api/cluster-access', { method: 'POST', path: '/q1/dismiss' });
    expect(answer.body).toMatchObject({ status: 'dismissed' });
  });
});
