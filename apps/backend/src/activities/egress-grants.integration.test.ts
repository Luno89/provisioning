import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptiedEachTime } from '../platform/lib/test-database.js';
import { EgressProxyService, EgressService } from '../infrastructure/index.js';
import { proxyUser } from '../infrastructure/lib/egress-proxy.js';
import { provisionPlatformService } from './platform-provision.js';
import type { Pause } from './watched-apply.js';
import { platformCluster, platformPlan, quickly, type PlatformCluster } from './testing/platform-cluster.js';

const fresh = await emptiedEachTime();

let cluster: PlatformCluster;

beforeAll(async () => { cluster = await platformCluster(import.meta.filename); }, 0);

afterAll(async () => { await cluster?.k3s.stop(); }, 0);

describe('the egress grants on a fresh cluster', () => {
  it('a grants writer that writes while the egress stack applies leaves the apply succeeding, and the grants are in place once the proxy is up', async () => {
    const { access, own, place, infra } = cluster;
    const db = await fresh();
    await db.infrastructure.saveEgressGrant({ id: 'g1', ownerId: 'owner-1', agentSlug: 'executor', host: 'api.example.com', reason: 'docs', approvedBy: 'owner-1', approvedAt: '2026-11-22T09:00:00.000Z' });
    const egress = new EgressService({ store: db.infrastructure, proxy: new EgressProxyService({ kube: access, secret: 'egress-secret' }), log: () => undefined });
    let early: Promise<unknown> | undefined;
    const writerWritesFirst: Pause = async (ms) => {
      early ??= egress.syncProxy().then(() => 'written', (err: unknown) => err);
      await early;
      return quickly(ms);
    };
    const told: string[] = [];

    await provisionPlatformService({ access, infra }, place, platformPlan('egress'), (line) => told.push(line), writerWritesFirst);

    expect(told.at(-1)).toBe('the egress proxy: ready');
    expect(early).toBeDefined();
    await egress.syncProxy();
    const user = proxyUser('owner-1', 'executor');
    expect(await access.kubectl(own, ['get', 'configmap', 'egress-grants', '-n', 'koala-egress', '-o', 'jsonpath={.data.acls\\.conf}'])).toContain(`acl hosts_${user} dstdomain api.example.com`);
    expect(await access.kubectl(own, ['exec', '-n', 'koala-egress', 'deploy/egress-proxy', '-c', 'squid', '--', 'cat', '/etc/squid/grants/passwd'])).toContain(`${user}:$6$`);
  }, 0);
});
