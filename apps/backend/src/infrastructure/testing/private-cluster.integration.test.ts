import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { nodeProcesses, nodeStreams, succeeded } from '../../platform/index.js';
import { CLUSTER_TOOL_PATHS, ClusterAccess } from '../services/ClusterAccess.js';
import { clusterWide, namespacesOf } from './cluster-wide.js';
import { controlPlaneGone, privateCluster } from './private-cluster.js';

const shared = join(mkdtempSync(join(tmpdir(), 'koala-private-cluster-')), 'shared.yaml');
writeFileSync(shared, inject('k3s').admin, { mode: 0o600 });
const onShared = (...args: string[]) => succeeded(nodeProcesses, { command: CLUSTER_TOOL_PATHS.kubectl, args: ['--kubeconfig', shared, ...args] });

describe('a cluster of a test file\'s own', () => {
  it('gives a file a cluster of its own inside the run\'s k3s that no other file sees, with the runtime and Helm kinds a machine\'s k3s has, and takes it away after', async () => {
    const before = await clusterWide(shared);
    const cluster = await privateCluster(import.meta.filename);
    const access = new ClusterAccess({ here: { koalaMachineId: 'desk', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-private-cluster-access-')), processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: cluster.account });
    const own = access.own();

    expect(cluster.namespace).toMatch(/^vc-private-cluster-[0-9a-f]{8}$/);
    expect(await namespacesOf(shared)).toContain(cluster.namespace);
    const sharedAccess = new ClusterAccess({ here: { koalaMachineId: 'desk', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-private-cluster-shared-')), processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: inject('k3s').account });
    expect(await controlPlaneGone(sharedAccess, cluster.namespace)).toBeUndefined();

    await access.apply(own, JSON.stringify({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'only-in-here' }, rules: [] }));
    await access.apply(own, JSON.stringify({
      apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'gadgets.private.test' },
      spec: { group: 'private.test', scope: 'Namespaced', names: { plural: 'gadgets', kind: 'Gadget' }, versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: { type: 'object' } } }] },
    }));
    await access.kubectl(own, ['create', 'namespace', 'shop']);
    await access.kubectl(own, ['run', 'web', '-n', 'shop', '--image=busybox:1.37', '--restart=Never', '--', 'sh', '-c', 'nslookup kubernetes.default.svc.cluster.local && sleep 3600']);
    await access.kubectl(own, ['wait', '--for=condition=Ready', 'pod/web', '-n', 'shop', '--timeout=720h']);

    expect(await access.kubectl(own, ['get', 'clusterrole', 'only-in-here', '-o', 'name'])).toBe('clusterrole.rbac.authorization.k8s.io/only-in-here\n');
    expect(await access.kubectl(own, ['get', 'runtimeclass', 'nvidia', '-o', 'jsonpath={.handler}'])).toBe('nvidia');
    expect(await access.kubectl(own, ['get', 'helmchartconfigs', '-n', 'kube-system', '-o', 'name'])).toBe('');
    expect((await clusterWide(shared)).filter((entry) => !before.includes(entry))).toEqual([]);
    expect(await namespacesOf(shared)).not.toContain('shop');
    expect(await onShared('get', 'pods', '-n', cluster.namespace, '-l', 'vcluster.loft.sh/namespace=shop', '-o', 'name')).not.toBe('');

    await cluster.stop();

    expect(await namespacesOf(shared)).not.toContain(cluster.namespace);
    expect(await controlPlaneGone(sharedAccess, cluster.namespace)).toBe('its control plane is gone');
  }, 0);
});
