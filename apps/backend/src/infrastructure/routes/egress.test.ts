import type { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { EgressGrantRecord, EgressRequest } from '@koala/harness-types';
import type { EgressService } from '../services/EgressService.js';
import { egressRouter } from './egress.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/egress', router: () => router, user: PERSON });

const request = { id: 'r1', ownerId: PERSON.id, agentSlug: 'executor', host: 'example.com', why: 'docs', status: 'requested', createdAt: 'x', updatedAt: 'x' } as EgressRequest;
const grant = { id: 'g1', ownerId: PERSON.id, agentSlug: 'executor', host: 'example.com', reason: 'docs', approvedBy: PERSON.id, approvedAt: 'x' } as EgressGrantRecord;

describe('/api/egress', () => {
  it('lists the person\'s requests, narrowed by conversation and tree when named', async () => {
    const egress = mock<EgressService>();
    egress.requests.calledWith(PERSON.id, matches<{ conversationId?: string | undefined; treeId?: string | undefined }>((filter) => filter.conversationId === 'c1' && filter.treeId === 't1')).mockResolvedValue([request]);
    egress.requests.calledWith(PERSON.id, matches<{ conversationId?: string | undefined; treeId?: string | undefined }>((filter) => filter.conversationId === undefined && filter.treeId === undefined)).mockResolvedValue([]);
    const router = egressRouter({ egress });
    expect((await (await on(router)).get('/api/egress/requests?conversationId=c1&treeId=t1')).data).toEqual([request]);
    expect((await (await on(router)).get('/api/egress/requests')).data).toEqual([]);
  });

  it('lists the person\'s grants for the agent named', async () => {
    const egress = mock<EgressService>();
    egress.grants.calledWith(PERSON.id, 'executor').mockResolvedValue([grant]);
    expect((await (await on(egressRouter({ egress }))).get('/api/egress/grants?agent=executor')).data).toEqual([grant]);
  });

  it('answers an allowed request with the request and the grant it made', async () => {
    const egress = mock<EgressService>();
    egress.allow.calledWith(PERSON.id, 'r1').mockResolvedValue({ ok: true, request: { ...request, status: 'allowed' }, grant });
    const answer = await (await on(egressRouter({ egress }))).post('/api/egress/requests/r1/allow');
    expect(answer.data).toEqual({ request: { ...request, status: 'allowed' }, grant });
  });

  it('answers a dismissed request with the request alone and a revoked grant with the grant alone', async () => {
    const egress = mock<EgressService>();
    egress.dismiss.mockResolvedValue({ ok: true, request: { ...request, status: 'dismissed' } });
    egress.revoke.mockResolvedValue({ ok: true, grant: { ...grant, revokedAt: 'y' } });
    const router = egressRouter({ egress });
    expect((await (await on(router)).post('/api/egress/requests/r1/dismiss')).data).toEqual({ request: { ...request, status: 'dismissed' } });
    expect((await (await on(router)).post('/api/egress/grants/g1/revoke')).data).toEqual({ grant: { ...grant, revokedAt: 'y' } });
  });

  it('answers the status and words the service refused with', async () => {
    const egress = mock<EgressService>();
    egress.allow.mockResolvedValue({ ok: false, status: 409, error: 'This request is already allowed.' });
    const answer = await (await on(egressRouter({ egress }))).post('/api/egress/requests/r1/allow');
    expect(answer.status).toBe(409);
    expect(answer.data).toEqual({ error: 'This request is already allowed.' });
  });
});
