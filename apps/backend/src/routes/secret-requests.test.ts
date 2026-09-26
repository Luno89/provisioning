import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { secretRequestsRouter } from './secret-requests.js';
import { SecretRequestService, type VaultBackend } from '../services/SecretRequestService.js';
import type { SecretRequest } from '../lib/secret-requests.js';

const post = (url: string, body: unknown) => axios.post(url, body, { validateStatus: () => true });
const get = (url: string) => axios.get(url, { validateStatus: () => true });

const request = (over: Partial<SecretRequest> = {}): SecretRequest => ({
  id: 'req-1',
  ownerId: TEST_USER.id,
  projectId: 'p1',
  key: 'STRIPE_API_KEY',
  description: 'The live key',
  secretReference: 'secret://p1/STRIPE_API_KEY',
  status: 'requested',
  conversationId: 'conv-1',
  createdAt: '2026-09-26T00:00:00Z',
  updatedAt: '2026-09-26T00:00:00Z',
  ...over,
});

describe('/api/secret-requests', () => {
  let harness: Harness;
  let held: Map<string, string>;
  let vaultDown: boolean;

  beforeEach(async () => {
    held = new Map();
    vaultDown = false;
    const vault: VaultBackend = {
      hasSecret: async (projectId, key) => held.has(`${projectId}/${key}`),
      setSecret: async (projectId, key, value) => {
        if (vaultDown) throw new Error('Request failed with status code 503');
        held.set(`${projectId}/${key}`, value);
        return { secretReference: `secret://${projectId}/${key}` };
      },
    };
    harness = await mountRouter({
      prefix: '/api/secret-requests',
      router: (db) => secretRequestsRouter({ secrets: new SecretRequestService({ store: db, vault }) }),
    });
    await harness.db.saveProject({ id: 'p1', name: 'billing', ownerId: TEST_USER.id, appType: 'gitapp', createdAt: 'now' });
    await harness.db.saveSecretRequest(request());
  });

  afterEach(() => harness.close());

  it('lists a conversation\'s requests', async () => {
    const res = await get(harness.url('/api/secret-requests?conversationId=conv-1'));
    expect(res.status).toBe(200);
    expect(res.data.map((entry: SecretRequest) => entry.key)).toEqual(['STRIPE_API_KEY']);
  });

  it('puts the value in the vault, marks the request provided, and answers without the value', async () => {
    const res = await post(harness.url('/api/secret-requests/req-1/submit'), { value: 'sk_live_sentinel' });

    expect(res.status).toBe(200);
    expect(res.data.status).toBe('provided');
    expect(JSON.stringify(res.data)).not.toContain('sk_live_sentinel');
    expect(held.get('p1/STRIPE_API_KEY')).toBe('sk_live_sentinel');
    const project = (await harness.db.getProjects()).find((candidate) => candidate.id === 'p1');
    expect(project?.requiredSecrets).toEqual([{ key: 'STRIPE_API_KEY', source: 'person' }]);
  });

  it('keeps the request open and says so when the vault does not accept the value', async () => {
    vaultDown = true;
    const res = await post(harness.url('/api/secret-requests/req-1/submit'), { value: 'sk_live_sentinel' });

    expect(res.status).toBe(502);
    expect(res.data.error).toContain('did not accept STRIPE_API_KEY');
    expect(res.data.error).not.toContain('sk_live_sentinel');
    expect((await harness.db.getSecretRequest(TEST_USER.id, 'req-1'))?.status).toBe('requested');
  });

  it('refuses an empty value, a settled request, and someone else\'s request', async () => {
    expect((await post(harness.url('/api/secret-requests/req-1/submit'), { value: '' })).status).toBe(400);

    await harness.db.saveSecretRequest(request({ id: 'req-2', status: 'provided' }));
    expect((await post(harness.url('/api/secret-requests/req-2/submit'), { value: 'x' })).status).toBe(409);

    await harness.db.saveSecretRequest(request({ id: 'req-3', ownerId: 'someone-else' }));
    expect((await post(harness.url('/api/secret-requests/req-3/submit'), { value: 'x' })).status).toBe(404);
    expect(held.size).toBe(0);
  });

  it('dismisses an open request without touching the vault', async () => {
    const res = await post(harness.url('/api/secret-requests/req-1/dismiss'), {});
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('dismissed');
    expect(held.size).toBe(0);
  });
});
