import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { asPerson, encryptValue, nodeProcesses, nodeStreams, type ClusterMetadata, type DeploymentMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { TOOLS } from '../testing/real-k3s.js';
import { ClusterAccess, runnersByRecord } from './ClusterAccess.js';
import { ClusterContentsService } from './ClusterContentsService.js';
import { testNamespaces } from '../testing/test-namespaces.js';

const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
const SHOP = namespaces.name('shop');

afterAll(async () => { await namespaces.removeAll(); }, 0);
const KEY = 'contents-key' as never;
const desk = { id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'healthy', ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata;
const resting = { id: 'machine-resting', name: 'resting', provider: 'machine', machineId: 'resting', status: 'healthy', ownerId: 'bo', createdAt: 't' } as ClusterMetadata;

describe('what is on a machine\'s cluster, read through ClusterAccess', () => {
  it('reads the app\'s workload, the nodes and the releases on the real cluster, and says why for a cluster it cannot reach', async () => {
    const db = await testDatabase();
    for (const record of [desk, { ...resting, status: 'stopped' as const }]) await db.infrastructure.saveCluster(record);
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'elsewhere', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-contents-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY });
    await access.kubectl(desk.id, ['create', 'namespace', SHOP]);
    await access.kubectl(desk.id, ['create', 'deployment', 'shop', '-n', SHOP, '--image=registry.k8s.io/pause:3.9']);
    await access.kubectl(desk.id, ['rollout', 'status', 'deployment/shop', '-n', SHOP, '--timeout=720h']);
    const chart = mkdtempSync(join(tmpdir(), 'koala-contents-chart-'));
    mkdirSync(join(chart, 'templates'));
    writeFileSync(join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: shelf\nversion: 0.1.0\nappVersion: "1.2"\n');
    writeFileSync(join(chart, 'templates', 'note.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shelf-note\ndata:\n  said: hello\n');
    await access.helm(desk.id, ['install', 'shelf', chart, '-n', SHOP, '--wait']);
    const contents = new ClusterContentsService({
      monitoring: { clustersOf: async () => [desk, resting], ownsCluster: () => true, reach: async () => ({}) },
      deployments: async () => [{ id: 'd1', name: 'shop', namespace: SHOP, clusterId: desk.id, ownerId: 'bo', status: 'running' }] as DeploymentMetadata[],
      ...runnersByRecord(access),
      labelOf: (id) => id,
    });

    const read = await contents.contents(asPerson('bo'), desk.id);
    expect(read.reachable).toBe(true);
    expect(read.workloads.find((workload) => workload.namespace === SHOP)).toMatchObject({ group: 'apps', name: 'shop', state: 'ok' });
    expect(read.nodes?.length).toBe(1);
    expect(read.releases?.find((release) => release.namespace === SHOP)).toMatchObject({ name: 'shelf', status: 'deployed', chart: 'shelf-0.1.0', app_version: '1.2' });
    expect(read.releasesProblem).toBeUndefined();

    const unreached = await contents.contents(asPerson('bo'), resting.id);
    expect(unreached).toMatchObject({ reachable: false, problem: 'it does not answer (resting is stopped until something runs on it)' });
  }, 300_000);
});
