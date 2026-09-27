import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { clusterAccessRouter } from './cluster-access.js';
import { AccessService } from '../services/AccessService.js';

const post = (url: string) => axios.post(url, {}, { validateStatus: () => true });

describe('/api/cluster-access', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await mountRouter({ prefix: '/api/cluster-access', router: (db) => clusterAccessRouter({ access: new AccessService({ store: db }) }) });
    await harness.db.saveConversation({ id: 'c1', ownerId: TEST_USER.id, title: 't', messages: [], createdAt: 'x', updatedAt: 'x' });
    await harness.db.saveAccessRequest({ id: 'q1', ownerId: TEST_USER.id, conversationId: 'c1', namespaces: ['monitoring'], why: 'prometheus', status: 'requested', createdAt: 'x', updatedAt: 'x' });
  });

  afterEach(() => harness.close());

  it('refuses anyone who is not an administrator', async () => {
    const res = await post(harness.url('/api/cluster-access/q1/grant'));
    expect(res.status).toBe(403);
    expect((await harness.db.getConversation(TEST_USER.id, 'c1'))?.platformNamespaces).toBeUndefined();
  });

  it('opens exactly the asked namespaces for that conversation when an administrator grants it', async () => {
    harness.setUser({ ...TEST_USER, isAdmin: true });
    const res = await post(harness.url('/api/cluster-access/q1/grant'));
    expect(res.data.status).toBe('granted');
    expect((await harness.db.getConversation(TEST_USER.id, 'c1'))?.platformNamespaces).toEqual(['monitoring']);
    expect((await post(harness.url('/api/cluster-access/q1/grant'))).status).toBe(409);
  });

  it('never opens the vault, even if a request for it was stored', async () => {
    harness.setUser({ ...TEST_USER, isAdmin: true });
    await harness.db.saveAccessRequest({ id: 'q2', ownerId: TEST_USER.id, conversationId: 'c1', namespaces: ['infisical'], why: 'x', status: 'requested', createdAt: 'x', updatedAt: 'x' });
    expect((await post(harness.url('/api/cluster-access/q2/grant'))).status).toBe(409);
  });

  it('dismisses', async () => {
    expect((await post(harness.url('/api/cluster-access/q1/dismiss'))).data.status).toBe('dismissed');
  });
});
