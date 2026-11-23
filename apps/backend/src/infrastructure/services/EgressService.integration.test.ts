import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reopening } from '@koala/engine-core/reopening';
import { nodeProcesses, nodeStreams, succeeded } from '../../platform/index.js';
import { emptiedEachTime, testDatabase } from '../../platform/lib/test-database.js';
import { egressBehaviour } from '../testing/egress-behaviour.js';
import { privateCluster, type PrivateCluster } from '../testing/private-cluster.js';
import { CLUSTER_TOOL_PATHS, ClusterAccess } from './ClusterAccess.js';
import { EgressProxyService, PROXY_NAMESPACE } from './EgressProxyService.js';
import { EgressService } from './EgressService.js';

egressBehaviour(await emptiedEachTime());

const PROXY_MANIFEST = resolve(import.meta.dirname, '../../../../../k8s/koala-egress/egress-proxy.yaml');

describe('the egress proxy on a real cluster', () => {
  let k3s: PrivateCluster;
  let adminFile: string;
  const admin = (...args: string[]): Promise<string> => succeeded(nodeProcesses, { command: CLUSTER_TOOL_PATHS.kubectl, args: ['--kubeconfig', adminFile, ...args] });

  beforeAll(async () => {
    k3s = await privateCluster(import.meta.filename);
    adminFile = join(k3s.folder, 'admin.yaml');
    await admin('create', 'namespace', PROXY_NAMESPACE);
    await admin('create', 'configmap', 'egress-grants', '-n', PROXY_NAMESPACE, '--from-literal=passwd=', '--from-literal=acls.conf=');
    await admin('apply', '-f', PROXY_MANIFEST);
    await admin('rollout', 'status', 'deployment/egress-proxy', '-n', PROXY_NAMESPACE, '--timeout=720h');
  });

  afterAll(async () => { await k3s?.stop(); });

  it('a revoke the proxy refuses for good is not tried again, and leaves the proxy\'s config with the next change once the proxy answers again', async () => {
    const db = await testDatabase();
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'home', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-egress-')), processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: k3s.account });
    const egress = new EgressService({ store: db.infrastructure, proxy: new EgressProxyService({ kube: access, secret: 'egress-test-secret' }), again: () => reopening(200), log: () => undefined });
    const asked = (id: string, host: string) => db.infrastructure.saveEgressRequest({ id, ownerId: 'owner', agentSlug: 'executor', host, why: 'docs', status: 'requested', createdAt: 'x', updatedAt: 'x' });
    await asked('r1', 'example.com');
    const held = async (): Promise<string> => admin('exec', '-n', PROXY_NAMESPACE, 'deploy/egress-proxy', '-c', 'squid', '--', 'cat', '/etc/squid/grants/acls.conf');

    const allowed = await egress.allow('owner', 'r1');
    expect(allowed.ok).toBe(true);
    expect(await held()).toContain('example.com');

    const noExec = resolve(import.meta.dirname, '../testing/egress-no-exec.yaml');
    await admin('delete', 'clusterrolebinding', 'koala');
    await admin('apply', '-f', noExec);

    const revoked = await egress.revoke('owner', allowed.ok ? allowed.grant!.id : '');
    expect(revoked).toMatchObject({ ok: false, status: 502 });
    expect(await egress.keepSynced()).toBe(false);
    expect(egress.proxyBehindSince()).toMatchObject({ reason: expect.stringMatching(/forbidden/i) as unknown, refused: true });
    expect(await held()).toContain('example.com');

    await admin('delete', '-f', noExec);
    await admin('create', 'clusterrolebinding', 'koala', '--clusterrole=cluster-admin', '--serviceaccount=default:koala');

    await asked('r2', 'example.org');
    expect(await egress.allow('owner', 'r2')).toMatchObject({ ok: true });
    expect(egress.proxyBehindSince()).toBeUndefined();
    const now = await held();
    expect(now).toContain('example.org');
    expect(now).not.toContain('example.com');
  });
});
