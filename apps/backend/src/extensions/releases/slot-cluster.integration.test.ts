import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { giteaStandIn, type GiteaStandIn } from '../../projects/testing/gitea-api.js';
import { encryptValue, nodeProcesses, nodeStreams, type ClusterMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { ClusterAccess } from '../../infrastructure/index.js';
import { TOOLS } from '../../infrastructure/testing/real-k3s.js';
import { createSlotCluster } from './slot-cluster.js';
import { testNamespaces } from '../../infrastructure/testing/test-namespaces.js';

const KEY = 'test-key' as never;
const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
const FIRST = namespaces.name('shop');
const SECOND = namespaces.name('shop');

afterAll(async () => { await namespaces.removeAll(); }, 0);
const COMMIT = 'c'.repeat(40);
const FILES: Record<string, string> = {
  'deploy/chart/Chart.yaml': 'apiVersion: v2\nname: shop\nversion: 0.1.0\n',
  'deploy/chart/templates/odoo.yaml': 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-odoo\ndata:\n  live: {{ .Values.live | quote }}\n',
  'addons/shop/__manifest__.py': "{'name': 'Shop'}\n",
};
let gitea: GiteaStandIn;
let access: ClusterAccess;

beforeAll(async () => {
  gitea = await giteaStandIn({ owner: 'bo', name: 'shop', commit: COMMIT, files: FILES });
  const db = await testDatabase();
  await db.infrastructure.saveCluster({ id: 'machine-slots', name: 'slots', provider: 'machine', machineId: 'slots', status: 'healthy', ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata);
  access = new ClusterAccess({
    clusters: db.infrastructure,
    here: { root: false },
    folder: mkdtempSync(join(tmpdir(), 'koala-slot-cluster-')),
    processes: nodeProcesses,
    streams: nodeStreams,
    tools: TOOLS,
    dataKey: KEY,
  });
});
afterAll(async () => { await gitea.close(); });

const target = { clusterId: 'machine-slots', clusterName: 'slots', provider: 'machine', namespace: FIRST, release: 'shop-1', owner: { ownerId: 'bo', projectId: 'p1' } };
const registry = async () => ({ hosts: { push: 'r', pull: 'r' }, username: 'u', password: 'p' });

describe('a release slot on a real cluster, reading its build\'s files through Gitea', () => {
  it('lists and reads the build\'s files, installs the chart it holds, and reads back what is installed', async () => {
    const cluster = createSlotCluster({ access, repo: async () => gitea.gitea(), registry, syncVault: async () => undefined });
    const source = { owner: 'bo', repo: 'shop', commit: COMMIT };
    expect(await cluster.files(source)).toEqual(Object.keys(FILES));
    expect(await cluster.file(source, 'addons/shop/__manifest__.py')).toBe("{'name': 'Shop'}\n");
    expect(await cluster.file(source, 'missing.txt')).toBeNull();
    expect(await cluster.state(target)).toEqual({ installed: false, live: 'a', tags: {} });
    await cluster.apply(target, source, ['--set', 'live=b', '--set', 'slots.b.tag=two']);
    expect(gitea.asked.every((line) => line.endsWith('token bot-token'))).toBe(true);
    expect(await access.kubectl(target.clusterId, ['get', 'configmap', 'shop-1-odoo', '-n', FIRST, '-o', 'jsonpath={.data.live}'])).toBe('b');
    expect(await access.kubectl(target.clusterId, ['get', 'namespace', FIRST, '-o', 'jsonpath={.metadata.labels.koala\\.dev/project}'])).toBe('p1');
    expect(await access.kubectl(target.clusterId, ['get', 'serviceaccount', 'default', '-n', FIRST, '-o', 'jsonpath={.imagePullSecrets[0].name}'])).toBe('koala-registry-pull');
    expect(await cluster.state(target)).toEqual({ installed: true, live: 'b', tags: { a: undefined, b: 'two' } });
  });

  it('puts and removes what a release step makes in its namespace, and syncs the vault with runners on that cluster', async () => {
    const cluster = createSlotCluster({
      access,
      repo: async () => gitea.gitea(),
      registry,
      syncVault: async (args) => {
        await args.cluster.applyManifest(JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: args.secretName, namespace: args.namespace }, stringData: { POSTGRES_PASSWORD: 'x' } }));
      },
    });
    const put = { ...target, namespace: SECOND, release: 'shop-2' };
    await cluster.put(put, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'step', namespace: 'elsewhere' }, data: { a: 'b' } });
    expect(await access.kubectl(put.clusterId, ['get', 'configmap', 'step', '-n', SECOND, '-o', 'jsonpath={.data.a}'])).toBe('b');
    await cluster.vault(put, { projectId: 'p1', secret: 'shop-2-vault', keys: ['POSTGRES_PASSWORD'] } as never);
    await cluster.remove(put, 'configmap', 'step', true);
    expect(await access.kubectl(put.clusterId, ['get', 'configmap', '-n', SECOND, '--field-selector', 'metadata.name=step', '-o', 'name'])).toBe('');
  });
});
