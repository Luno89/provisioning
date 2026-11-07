import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptValue, nodeProcesses, type ClusterMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { startK3s, TOOLS, type RealK3s } from '../testing/real-k3s.js';
import { ClusterAccess } from './ClusterAccess.js';

const KEY = 'test-key' as never;

let k3s: RealK3s;
beforeAll(async () => { k3s = await startK3s(); });
afterAll(async () => { await k3s?.stop(); });

const machine = (overrides: Partial<ClusterMetadata>): ClusterMetadata =>
  ({ name: overrides.id, provider: 'machine', status: 'healthy', ownerId: 'owner', createdAt: 't', ...overrides }) as ClusterMetadata;

async function door(records: ClusterMetadata[], overrides: { dataKey?: never } = {}): Promise<ClusterAccess> {
  const db = await testDatabase();
  for (const record of records) await db.infrastructure.saveCluster(record);
  return new ClusterAccess({
    clusters: db.infrastructure,
    here: { koalaMachineId: 'dev1', root: false },
    folder: mkdtempSync(join(tmpdir(), 'koala-cluster-access-')),
    processes: nodeProcesses,
    tools: TOOLS,
    dataKey: KEY,
    serviceAccount: k3s.account,
    ...overrides,
  });
}

describe('ClusterAccess against a real k3s', () => {
  it('reaches the cluster Koala runs on with nothing but its service account, as a pod does', async () => {
    const access = await door([machine({ id: 'machine-dev1', machineId: 'dev1' })]);
    await access.kubectl('machine-dev1', ['create', 'namespace', 'koala-own']);
    expect(await access.kubectl('machine-dev1', ['get', 'namespace', 'koala-own', '-o', 'name'])).toBe('namespace/koala-own\n');
  });

  it('reaches another machine through the kubeconfig sealed on its record, kubectl and helm alike', async () => {
    const access = await door([machine({ id: 'machine-dev2', machineId: 'dev2', kubeconfigEnc: encryptValue(k3s.admin, KEY) })]);
    await access.kubectl('machine-dev2', ['create', 'configmap', 'shop', '-n', 'default', '--from-literal=a=b']);
    expect(await access.kubectl('machine-dev2', ['get', 'configmap', 'shop', '-n', 'default', '-o', 'jsonpath={.data.a}'])).toBe('b');
    expect(await access.helm('machine-dev2', ['list', '-A', '-o', 'json'])).toBe('[]\n');
  });

  it('applies what it is handed on stdin', async () => {
    const access = await door([machine({ id: 'machine-dev2', machineId: 'dev2', kubeconfigEnc: encryptValue(k3s.admin, KEY) })]);
    await access.kubectl('machine-dev2', ['apply', '-f', '-'], { input: 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: from-stdin\n' });
    expect(await access.kubectl('machine-dev2', ['get', 'namespace', 'from-stdin', '-o', 'name'])).toBe('namespace/from-stdin\n');
  });

  it('works a machine another step started with the kubeconfig that step hands over, holding no data key itself', async () => {
    const access = await door([machine({ id: 'machine-dev3', machineId: 'dev3', status: 'stopped' })], { dataKey: undefined as never });
    expect(await access.kubectl('machine-dev3', ['get', 'namespace', 'default', '-o', 'name'], { handed: k3s.admin })).toBe('namespace/default\n');
  });

  it('passes on what kubectl said when the cluster refuses', async () => {
    const access = await door([machine({ id: 'machine-dev2', machineId: 'dev2', kubeconfigEnc: encryptValue(k3s.admin, KEY) })]);
    await expect(access.kubectl('machine-dev2', ['get', 'namespace', 'nowhere'])).rejects.toThrow('namespaces "nowhere" not found');
  });
});
