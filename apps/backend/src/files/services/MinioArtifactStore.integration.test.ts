import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { encryptValue, nodeProcesses, nodeStreams, type ClusterMetadata, type DeploymentMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { ClusterAccess } from '../../infrastructure/index.js';
import { TOOLS } from '../../infrastructure/testing/real-k3s.js';
import { minioReachFrom } from './MinioArtifactStore.js';

const KEY = 'test-key' as never;
const k3s = inject('k3s');

describe('reaching a person\'s MinIO from Koala\'s own cluster', () => {
  it('finds it by its service name on Koala\'s own cluster, and at the mesh address and S3 node port on another machine, reading the real Service', async () => {
    const db = await testDatabase();
    const namespace = `store-${randomUUID().slice(0, 6)}`;
    await db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'healthy', ownerId: 'bo', createdAt: 't', meshIp: '100.64.0.7', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata);
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'dev1', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-minio-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY, serviceAccount: k3s.account });
    await access.kubectl('machine-desk', ['create', 'namespace', namespace]);
    await access.kubectl('machine-desk', ['create', 'service', 'nodeport', 'minio', '-n', namespace, '--tcp=9000:9000', '--tcp=9001:9001']);
    await access.kubectl('machine-desk', ['patch', 'service', 'minio', '-n', namespace, '--type=json', '-p', '[{"op":"replace","path":"/spec/ports/0/name","value":"s3"}]']);
    const nodePort = Number(await access.kubectl('machine-desk', ['get', 'service', 'minio', '-n', namespace, '-o', 'jsonpath={.spec.ports[?(@.name=="s3")].nodePort}']));
    const reach = minioReachFrom({ deployments: async () => [], access, clusterById: async (id) => (await db.infrastructure.getClusters()).find((c) => c.id === id) });
    const minio = (clusterId: string) => ({ id: 'm1', name: 'Store', appType: 'minio', namespace, clusterId, ownerId: 'bo', status: 'running', strategy: 'native' }) as DeploymentMetadata;

    expect(await reach.endpoint(minio('machine-desk'))).toEqual({ host: '100.64.0.7', port: nodePort });
    expect(await reach.endpoint(minio('machine-dev1'))).toEqual({ host: `minio.${namespace}.svc.cluster.local`, port: 9000 });
    await expect(reach.endpoint(minio('machine-gone'))).rejects.toThrow('machine-gone');
  }, 120_000);
});
