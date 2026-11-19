import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { ClusterAccess, ROOT_CLUSTER_ID } from '../infrastructure/index.js';
import { CLUSTER_TOOL_PATHS } from '../infrastructure/index.js';
import { PoolNode } from './pool-node.js';

const k3s = inject('k3s');

function rootsNode(): { access: ClusterAccess; pool: PoolNode } {
  const folder = mkdtempSync(join(tmpdir(), 'koala-pool-node-'));
  const rootKubeconfig = join(folder, 'pool.yaml');
  writeFileSync(rootKubeconfig, k3s.admin, { mode: 0o600 });
  const access = new ClusterAccess({ here: { root: true }, folder, processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, rootKubeconfig });
  return { access, pool: new PoolNode({ access, node: ROOT_CLUSTER_ID, sleep: async () => undefined }) };
}

describe('the pool\'s node reached as root\'s cluster, on a real k3s', () => {
  it('puts the proxy\'s Caddyfile there', async () => {
    const { access, pool } = rootsNode();
    await pool.proxy(':80 {\n\trespond "pool"\n}\n');
    expect(await access.kubectl(ROOT_CLUSTER_ID, ['get', 'configmap', 'pool-proxy', '-n', 'kube-system', '-o', 'jsonpath={.data.Caddyfile}'])).toContain('respond "pool"');
  });

  it('stops a trial\'s vcluster and its synced pods, starts it again, and removes it with its namespace', async () => {
    const { access, pool } = rootsNode();
    await access.apply(ROOT_CLUSTER_ID, [
      'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: pool-bea\n',
      'apiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: bea\n  namespace: pool-bea\nspec:\n  replicas: 1\n  serviceName: bea\n  selector:\n    matchLabels:\n      app: bea\n  template:\n    metadata:\n      labels:\n        app: bea\n    spec:\n      terminationGracePeriodSeconds: 0\n      containers:\n        - name: c\n          image: registry.invalid/none:1\n',
      'apiVersion: v1\nkind: Pod\nmetadata:\n  name: synced\n  namespace: pool-bea\n  labels:\n    vcluster.loft.sh/managed-by: bea\nspec:\n  terminationGracePeriodSeconds: 0\n  containers:\n    - name: c\n      image: registry.invalid/none:1\n',
    ].join('---\n'));
    await pool.replicas('bea', 0);
    expect(await access.kubectl(ROOT_CLUSTER_ID, ['get', 'statefulset', 'bea', '-n', 'pool-bea', '-o', 'jsonpath={.spec.replicas}'])).toBe('0');
    expect(await access.kubectl(ROOT_CLUSTER_ID, ['get', 'pods', '-n', 'pool-bea', '-l', 'vcluster.loft.sh/managed-by=bea', '-o', 'name'])).toBe('');
    await pool.replicas('bea', 1);
    expect(await access.kubectl(ROOT_CLUSTER_ID, ['get', 'statefulset', 'bea', '-n', 'pool-bea', '-o', 'jsonpath={.spec.replicas}'])).toBe('1');
    await pool.remove('bea');
    expect(await access.kubectl(ROOT_CLUSTER_ID, ['get', 'namespace', '--field-selector', 'metadata.name=pool-bea', '-o', 'name'])).toBe('');
  });
});
