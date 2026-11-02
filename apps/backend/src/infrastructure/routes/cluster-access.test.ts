import type { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { AccessRequest } from '@koala/harness-types';
import type { Principal } from '../../platform/index.js';
import type { AccessService } from '../services/AccessService.js';
import { clusterAccessRouter } from './cluster-access.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/cluster-access', router: () => router, user: PERSON });

const request = { id: 'q1', ownerId: PERSON.id, conversationId: 'c1', namespaces: ['monitoring'], why: 'prometheus', status: 'requested', createdAt: 'x', updatedAt: 'x' } as AccessRequest;

describe('/api/cluster-access', () => {
  it('lists the signed-in person\'s requests, narrowed to a conversation when one is named', async () => {
    const access = mock<AccessService>();
    access.list.calledWith(PERSON.id, undefined).mockResolvedValue([request]);
    access.list.calledWith(PERSON.id, 'c1').mockResolvedValue([]);
    const router = clusterAccessRouter({ access });
    expect((await (await on(router)).get('/api/cluster-access')).data).toEqual([request]);
    expect((await (await on(router)).get('/api/cluster-access?conversationId=c1')).data).toEqual([]);
  });

  it('grants as the person asking and answers with the decided request', async () => {
    const access = mock<AccessService>();
    access.grant.calledWith(matches<Principal>((who) => who.id === PERSON.id), 'q1').mockResolvedValue({ ok: true, request: { ...request, status: 'granted' } });
    const answer = await (await on(clusterAccessRouter({ access }))).post('/api/cluster-access/q1/grant');
    expect(answer.status).toBe(200);
    expect(answer.data).toMatchObject({ status: 'granted' });
  });

  it('answers the status and words the service refused a grant with', async () => {
    const access = mock<AccessService>();
    access.grant.mockResolvedValue({ ok: false, status: 403, error: 'only the operator opens platform namespaces' });
    const answer = await (await on(clusterAccessRouter({ access }))).post('/api/cluster-access/q1/grant');
    expect(answer.status).toBe(403);
    expect(answer.data).toEqual({ error: 'only the operator opens platform namespaces' });
  });

  it('dismisses a request for the person asking', async () => {
    const access = mock<AccessService>();
    access.dismiss.calledWith(PERSON.id, 'q1').mockResolvedValue({ ok: true, request: { ...request, status: 'dismissed' } });
    const answer = await (await on(clusterAccessRouter({ access }))).post('/api/cluster-access/q1/dismiss');
    expect(answer.data).toMatchObject({ status: 'dismissed' });
  });
});
