import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { EgressGrantRecord, EgressRequest } from '@koala/harness-types';
import type { Database } from '../../platform/lib/db-interface.js';
import { EgressService, type EgressProxy } from '../services/EgressService.js';

const OWNER = 'owner-1';
const NOW = '2026-11-02T00:00:00.000Z';

const asked = (over: Partial<EgressRequest> = {}): EgressRequest =>
  ({ id: 'r1', ownerId: OWNER, agentSlug: 'executor', host: 'example.com', why: 'docs', status: 'requested', createdAt: 'x', updatedAt: 'x', ...over });

export function egressBehaviour(make: () => Promise<Database>): void {
  describe('EgressService', () => {
    let db: Database;
    let proxy: ReturnType<typeof mock<EgressProxy>>;
    let egress: EgressService;

    beforeEach(async () => {
      db = await make();
      proxy = mock<EgressProxy>();
      proxy.sync.mockResolvedValue(undefined);
      egress = new EgressService({ store: db.infrastructure, proxy, now: () => NOW, newId: () => 'g1' });
      await db.infrastructure.saveEgressRequest(asked());
    });

    it('lists a person\'s requests, narrowed by conversation or tree', async () => {
      await db.infrastructure.saveEgressRequest(asked({ id: 'r2', conversationId: 'c1' }));
      await db.infrastructure.saveEgressRequest(asked({ id: 'r3', ownerId: 'someone-else' }));
      expect((await egress.requests(OWNER)).map((request) => request.id).sort()).toEqual(['r1', 'r2']);
      expect((await egress.requests(OWNER, { conversationId: 'c1' })).map((request) => request.id)).toEqual(['r2']);
    });

    it('allows a request by granting its host to the agent and telling the proxy', async () => {
      const decided = await egress.allow(OWNER, 'r1');
      expect(decided).toMatchObject({ ok: true, request: { id: 'r1', status: 'allowed', updatedAt: NOW }, grant: { id: 'g1', agentSlug: 'executor', host: 'example.com', reason: 'docs', approvedBy: OWNER, approvedAt: NOW } });
      expect(proxy.sync).toHaveBeenCalledTimes(1);
      expect((await egress.grants(OWNER)).map((grant) => grant.id)).toEqual(['g1']);
    });

    it('keeps the ports a request named on its grant', async () => {
      await db.infrastructure.saveEgressRequest(asked({ id: 'r2', ports: [8080] }));
      expect(await egress.allow(OWNER, 'r2')).toMatchObject({ grant: { ports: [8080] } });
    });

    it('grants nothing, and says so, when the proxy cannot be updated', async () => {
      proxy.sync.mockRejectedValueOnce(new Error('proxy down'));
      const decided = await egress.allow(OWNER, 'r1');
      expect(decided).toEqual({ ok: false, status: 502, error: 'The proxy could not be updated, so nothing was granted: proxy down' });
      expect(await egress.grants(OWNER)).toEqual([]);
      expect((await db.infrastructure.getEgressRequest(OWNER, 'r1'))?.status).toBe('requested');
    });

    it('says a request is gone or already decided', async () => {
      expect(await egress.allow(OWNER, 'nope')).toEqual({ ok: false, status: 404, error: 'Request not found' });
      await egress.allow(OWNER, 'r1');
      expect(await egress.allow(OWNER, 'r1')).toEqual({ ok: false, status: 409, error: 'This request is already allowed.' });
    });

    it('dismisses a request without granting anything', async () => {
      expect(await egress.dismiss(OWNER, 'r1')).toEqual({ ok: true, request: asked({ status: 'dismissed', updatedAt: NOW }) });
      expect(proxy.sync).not.toHaveBeenCalled();
      expect(await egress.dismiss(OWNER, 'r1')).toMatchObject({ ok: false, status: 409 });
    });

    it('lists only the grants still in force, for the agent named when one is', async () => {
      const grant = (id: string, over: Partial<EgressGrantRecord> = {}): EgressGrantRecord => ({ id, ownerId: OWNER, agentSlug: 'executor', host: 'a.test', reason: 'r', approvedBy: OWNER, approvedAt: 'x', ...over });
      await db.infrastructure.saveEgressGrant(grant('g-a'));
      await db.infrastructure.saveEgressGrant(grant('g-b', { agentSlug: 'research' }));
      await db.infrastructure.saveEgressGrant(grant('g-c', { revokedAt: 'y' }));
      expect((await egress.grants(OWNER)).map((entry) => entry.id).sort()).toEqual(['g-a', 'g-b']);
      expect((await egress.grants(OWNER, 'research')).map((entry) => entry.id)).toEqual(['g-b']);
    });

    it('revokes a grant, once, and tells the proxy', async () => {
      await egress.allow(OWNER, 'r1');
      proxy.sync.mockClear();
      const revoked = await egress.revoke(OWNER, 'g1');
      expect(revoked).toMatchObject({ ok: true, grant: { id: 'g1', revokedAt: NOW, revokedBy: OWNER } });
      expect(proxy.sync).toHaveBeenCalledTimes(1);
      expect(await egress.revoke(OWNER, 'g1')).toEqual({ ok: false, status: 409, error: 'This grant is already revoked.' });
      expect(await egress.revoke(OWNER, 'nope')).toEqual({ ok: false, status: 404, error: 'Grant not found' });
    });

    it('says the grant is revoked but the proxy has not heard yet when the proxy cannot be updated', async () => {
      await egress.allow(OWNER, 'r1');
      proxy.sync.mockRejectedValueOnce(new Error('proxy down'));
      expect(await egress.revoke(OWNER, 'g1')).toEqual({ ok: false, status: 502, error: 'Revoked, but the proxy could not be updated yet: proxy down' });
    });

    it('syncs the proxy with every grant, whoever\'s, and stamps decisions with the current time when no clock is given', async () => {
      const plain = new EgressService({ store: db.infrastructure, proxy });
      const decided = await plain.dismiss(OWNER, 'r1');
      expect(decided.ok && Date.parse(decided.request?.updatedAt ?? '')).toBeGreaterThan(Date.parse('2026-01-01'));
      const allowed = await plain.allow(OWNER, 'nope');
      expect(allowed.ok).toBe(false);
      await db.infrastructure.saveEgressRequest(asked({ id: 'r9' }));
      const granted = await plain.allow(OWNER, 'r9');
      expect(granted.ok && granted.grant?.id).toMatch(/^[0-9a-f-]{36}$/);
      await plain.syncProxy();
      expect(proxy.sync).toHaveBeenCalled();
    });
  });
}
