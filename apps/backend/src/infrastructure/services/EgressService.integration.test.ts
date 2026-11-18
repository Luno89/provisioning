import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reopening } from '@koala/engine-core/reopening';
import { nodeProcesses, nodeStreams, succeeded } from '../../platform/index.js';
import { emptiedEachTime, testDatabase } from '../../platform/lib/test-database.js';
import { egressBehaviour } from '../testing/egress-behaviour.js';
import { startK3s, TOOLS, type RealK3s } from '../testing/real-k3s.js';
import { ClusterAccess } from './ClusterAccess.js';
import { EgressProxyService, PROXY_NAMESPACE } from './EgressProxyService.js';
import { EgressService } from './EgressService.js';

egressBehaviour(await emptiedEachTime());

const PROXY_MANIFEST = resolve(import.meta.dirname, '../../../../../k8s/koala-egress/egress-proxy.yaml');

describe('the egress proxy on a real cluster', () => {
  let k3s: RealK3s;
  let adminFile: string;
  const admin = (...args: string[]): Promise<string> => succeeded(nodeProcesses, { command: TOOLS.kubectl, args: ['--kubeconfig', adminFile, ...args] });

  beforeAll(async () => {
    k3s = await startK3s();
    adminFile = join(k3s.folder, 'admin.yaml');
    await admin('create', 'namespace', PROXY_NAMESPACE);
    await admin('create', 'configmap', 'egress-grants', '-n', PROXY_NAMESPACE, '--from-literal=passwd=', '--from-literal=acls.conf=');
    await admin('apply', '-f', PROXY_MANIFEST);
    await admin('rollout', 'status', 'deployment/egress-proxy', '-n', PROXY_NAMESPACE, '--timeout=720h');
  });

  afterAll(async () => { await k3s?.stop(); });

  it('a revoked grant leaves the proxy\'s config once the proxy answers again', async () => {
    const db = await testDatabase();
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'home', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-egress-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, serviceAccount: k3s.account });
    const egress = new EgressService({ store: db.infrastructure, proxy: new EgressProxyService({ kube: access, secret: 'egress-test-secret' }), again: () => reopening(200), log: () => undefined });
    await db.infrastructure.saveEgressRequest({ id: 'r1', ownerId: 'owner', agentSlug: 'executor', host: 'example.com', why: 'docs', status: 'requested', createdAt: 'x', updatedAt: 'x' });
    const held = async (): Promise<string> => admin('exec', '-n', PROXY_NAMESPACE, 'deploy/egress-proxy', '-c', 'squid', '--', 'cat', '/etc/squid/grants/acls.conf');

    const allowed = await egress.allow('owner', 'r1');
    expect(allowed.ok).toBe(true);
    expect(await held()).toContain('example.com');

    const noExec = resolve(import.meta.dirname, '../testing/egress-no-exec.yaml');
    await admin('delete', 'clusterrolebinding', 'koala');
    await admin('apply', '-f', noExec);

    const revoked = await egress.revoke('owner', allowed.ok ? allowed.grant!.id : '');
    expect(revoked).toMatchObject({ ok: false, status: 502 });
    expect(egress.proxyBehindSince()).toMatchObject({ reason: expect.stringMatching(/forbidden/i) as unknown });
    expect(await held()).toContain('example.com');

    await admin('delete', '-f', noExec);
    await admin('create', 'clusterrolebinding', 'koala', '--clusterrole=cluster-admin', '--serviceaccount=default:koala');

    await vi.waitFor(() => expect(egress.proxyBehindSince()).toBeUndefined(), { timeout: 120_000, interval: 200 });
    expect(await held()).not.toContain('example.com');
  });
});
