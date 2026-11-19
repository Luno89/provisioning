import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeProcesses, succeeded } from '../../platform/index.js';
import { clusterWide, namespacesOf } from './cluster-wide.js';
import { startK3s, type RealK3s } from './real-k3s.js';
import { CLUSTER_TOOL_PATHS } from '../services/ClusterAccess.js';

let k3s: RealK3s;
let kubeconfig: string;
const kubectl = (...args: string[]) => succeeded(nodeProcesses, { command: CLUSTER_TOOL_PATHS.kubectl, args: ['--kubeconfig', kubeconfig, ...args] });

beforeAll(async () => {
  k3s = await startK3s();
  kubeconfig = join(mkdtempSync(join(tmpdir(), 'koala-cluster-wide-')), 'admin.yaml');
  writeFileSync(kubeconfig, k3s.admin, { mode: 0o600 });
});

afterAll(async () => { await k3s.stop(); });

describe('what a test leaves on a cluster beyond its own namespaces', () => {
  it('names a cluster-scoped object and a kube-system workload made after the cluster started, and a namespace left', async () => {
    const before = await clusterWide(kubeconfig);
    const namespacesBefore = await namespacesOf(kubeconfig);
    await kubectl('create', 'clusterrole', 'left-behind', '--verb=get', '--resource=pods');
    await kubectl('create', 'deployment', 'left-behind', '-n', 'kube-system', '--image=registry.k8s.io/pause:3.10');
    await kubectl('create', 'namespace', 'left-behind');
    const after = await clusterWide(kubeconfig);
    expect(after.filter((entry) => !before.includes(entry))).toEqual(['ClusterRole/left-behind', 'kube-system/Deployment/left-behind']);
    expect((await namespacesOf(kubeconfig)).filter((entry) => !namespacesBefore.includes(entry))).toEqual(['left-behind']);
  });
});
