import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { egressRouter } from './egress.js';
import { EgressService } from '../services/EgressService.js';
import { EgressProxyService } from '../services/EgressProxyService.js';
import type { EgressGrantRecord } from '@koala/harness-types';

const post = (url: string) => axios.post(url, {}, { validateStatus: () => true });

describe('/api/egress', () => {
  let harness: Harness;
  let synced: EgressGrantRecord[][];
  let proxyDown: boolean;

  beforeEach(async () => {
    synced = [];
    proxyDown = false;
    harness = await mountRouter({
      prefix: '/api/egress',
      router: (db) => egressRouter({
        egress: new EgressService({
          store: db,
          newId: () => 'g1',
          proxy: { sync: async (grants) => { if (proxyDown) throw new Error('proxy unreachable'); synced.push([...grants]); } },
        }),
      }),
    });
    await harness.db.saveEgressRequest({ id: 'e1', ownerId: TEST_USER.id, agentSlug: 'executor', host: 'api.stripe.com', why: 'tests', status: 'requested', createdAt: 'x', updatedAt: 'x' });
  });

  afterEach(() => harness.close());

  it('allowing records a grant for that persona and host and pushes it to the proxy', async () => {
    const res = await post(harness.url('/api/egress/requests/e1/allow'));
    expect(res.data.request.status).toBe('allowed');
    expect(res.data.grant).toMatchObject({ agentSlug: 'executor', host: 'api.stripe.com', approvedBy: TEST_USER.id });
    expect(synced.at(-1)!.map((grant) => grant.host)).toEqual(['api.stripe.com']);
    expect((await axios.get(harness.url('/api/egress/grants?agent=executor'))).data).toHaveLength(1);
  });

  it('grants nothing when the proxy cannot be updated', async () => {
    proxyDown = true;
    const res = await post(harness.url('/api/egress/requests/e1/allow'));
    expect(res.status).toBe(502);
    expect((await axios.get(harness.url('/api/egress/grants'))).data).toEqual([]);
    expect((await harness.db.getEgressRequest(TEST_USER.id, 'e1'))?.status).toBe('requested');
  });

  it('revoking takes the host back out of the proxy', async () => {
    await post(harness.url('/api/egress/requests/e1/allow'));
    const res = await post(harness.url('/api/egress/grants/g1/revoke'));
    expect(res.data.grant.revokedAt).toBeDefined();
    expect((await axios.get(harness.url('/api/egress/grants'))).data).toEqual([]);
    expect((await post(harness.url('/api/egress/grants/g1/revoke'))).status).toBe(409);
  });
});

describe('EgressProxyService', () => {
  it('writes a sha512-crypt entry per persona and the ACLs, through the real openssl', async () => {
    const kube = { applyManifest: vi.fn(async () => ''), runKubectl: vi.fn(async () => '') };
    const proxy = new EgressProxyService({ kube, secret: 's', kubeconfig: 'k' });
    const { passwd, acls } = await proxy.files([
      { id: 'g', ownerId: 'u1', agentSlug: 'executor', host: 'api.stripe.com', approvedBy: 'u1', approvedAt: 't' },
      { id: 'h', ownerId: 'u1', agentSlug: 'executor', host: 'old.example.com', approvedBy: 'u1', approvedAt: 't', revokedAt: 't2' },
    ]);
    expect(passwd).toMatch(/^a[0-9a-f]{20}:\$6\$[^\n]+\n$/);
    expect(acls).toContain('api.stripe.com');
    expect(acls).not.toContain('old.example.com');
  });
});
