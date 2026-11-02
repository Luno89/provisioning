import { beforeEach, describe, expect, it } from 'vitest';
import type { AccessRequest } from '@koala/harness-types';
import { asPerson, principalOf } from '../../platform/index.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { AccessService } from '../services/AccessService.js';

const OWNER = 'owner-1';
const person = asPerson(OWNER);
const operator = principalOf({ id: OWNER, roles: ['operator'] }, { role: 'combined' });
const NOW = '2026-11-02T00:00:00.000Z';

const asked = (over: Partial<AccessRequest> = {}): AccessRequest =>
  ({ id: 'q1', ownerId: OWNER, conversationId: 'c1', namespaces: ['monitoring'], why: 'prometheus', status: 'requested', createdAt: 'x', updatedAt: 'x', ...over });

export function accessBehaviour(make: () => Promise<Database>): void {
  describe('AccessService', () => {
    let db: Database;
    let access: AccessService;

    beforeEach(async () => {
      db = await make();
      access = new AccessService({ store: db, now: () => NOW });
      await db.engine.saveConversation({ id: 'c1', ownerId: OWNER, title: 't', messages: [], createdAt: 'x', updatedAt: 'x' });
      await db.infrastructure.saveAccessRequest(asked());
    });

    it('lists a person\'s requests, narrowed to a conversation when one is named', async () => {
      await db.infrastructure.saveAccessRequest(asked({ id: 'q2', conversationId: 'c2' }));
      await db.infrastructure.saveAccessRequest(asked({ id: 'q3', ownerId: 'someone-else' }));
      expect((await access.list(OWNER)).map((request) => request.id).sort()).toEqual(['q1', 'q2']);
      expect((await access.list(OWNER, 'c2')).map((request) => request.id)).toEqual(['q2']);
    });

    it('refuses anyone who is not the operator the right to open platform namespaces', async () => {
      const decided = await access.grant(person, 'q1');
      expect(decided).toMatchObject({ ok: false, status: 403 });
      expect((await db.engine.getConversation(OWNER, 'c1'))?.platformNamespaces).toBeUndefined();
    });

    it('opens exactly the asked namespaces for that conversation when the operator grants it, once', async () => {
      const decided = await access.grant(operator, 'q1');
      expect(decided).toEqual({ ok: true, request: asked({ status: 'granted', updatedAt: NOW }) });
      const conversation = await db.engine.getConversation(OWNER, 'c1');
      expect(conversation?.platformNamespaces).toEqual(['monitoring']);
      expect(conversation?.updatedAt).toBe(NOW);
      expect(await access.grant(operator, 'q1')).toEqual({ ok: false, status: 409, error: 'This request is already granted.' });
    });

    it('adds to the namespaces a conversation already has without repeating one', async () => {
      const conversation = await db.engine.getConversation(OWNER, 'c1');
      await db.engine.saveConversation({ ...conversation!, platformNamespaces: ['monitoring', 'traefik'] });
      await access.grant(operator, 'q1');
      expect((await db.engine.getConversation(OWNER, 'c1'))?.platformNamespaces).toEqual(['monitoring', 'traefik']);
    });

    it('never opens the vault, even if a request for it was stored', async () => {
      await db.infrastructure.saveAccessRequest(asked({ id: 'q4', namespaces: ['infisical'] }));
      const decided = await access.grant(operator, 'q4');
      expect(decided).toMatchObject({ ok: false, status: 409 });
      expect((await db.engine.getConversation(OWNER, 'c1'))?.platformNamespaces).toBeUndefined();
    });

    it('says the request or its conversation is gone', async () => {
      expect(await access.grant(operator, 'nope')).toEqual({ ok: false, status: 404, error: 'Request not found' });
      await db.infrastructure.saveAccessRequest(asked({ id: 'q5', conversationId: 'gone' }));
      expect(await access.grant(operator, 'q5')).toEqual({ ok: false, status: 404, error: 'The conversation this was asked in no longer exists' });
    });

    it('dismisses a request, once', async () => {
      expect(await access.dismiss(OWNER, 'q1')).toEqual({ ok: true, request: asked({ status: 'dismissed', updatedAt: NOW }) });
      expect(await access.dismiss(OWNER, 'q1')).toEqual({ ok: false, status: 409, error: 'This request is already dismissed.' });
      expect(await access.dismiss('someone-else', 'q1')).toEqual({ ok: false, status: 404, error: 'Request not found' });
    });

    it('stamps decisions with the current time when no clock is given', async () => {
      const decided = await new AccessService({ store: db }).dismiss(OWNER, 'q1');
      expect(decided.ok && Date.parse(decided.request.updatedAt)).toBeGreaterThan(Date.parse('2026-01-01'));
    });
  });
}
