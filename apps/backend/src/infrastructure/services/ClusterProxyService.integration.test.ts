import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { encryptValue, nodeProcesses, nodeStreams, type ClusterMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { TOOLS } from '../testing/real-k3s.js';
import { ClusterAccess } from './ClusterAccess.js';
import { ClusterProxyService } from './ClusterProxyService.js';

const KEY = 'test-key' as never;
const k3s = inject('k3s');

const opens = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

describe('forwarding to a service in a cluster through ClusterAccess', () => {
  it('starts kubectl port-forward through ClusterAccess on the machine\'s own kubeconfig, answers on this computer, and stops it', async () => {
    const db = await testDatabase();
    await db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'healthy', ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata);
    await db.infrastructure.saveCluster({ id: 'machine-nas', name: 'nas', provider: 'machine', machineId: 'nas', status: 'stopped', ownerId: 'bo', createdAt: 't' } as ClusterMetadata);
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-proxy-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY });
    await access.kubectl('machine-desk', ['-n', 'kube-system', 'rollout', 'status', 'deployment/coredns']);
    const proxy = new ClusterProxyService(access, async () => false);
    const dns = { service: 'kube-dns', namespace: 'kube-system', remotePort: 53 };

    const url = await proxy.serviceUrl('machine-desk', 'dns', dns);
    const port = Number(new URL(url).port);
    expect(url).toBe(`http://localhost:${port}/`);
    expect(await opens(port)).toBe(true);
    expect(await proxy.ensurePortForward('machine-desk', 'dns', dns)).toBe(url);

    proxy.stopForCluster('machine-desk');
    for (let tries = 0; tries < 100 && await opens(port); tries += 1) await new Promise((done) => setTimeout(done, 100));
    expect(await opens(port)).toBe(false);

    await expect(proxy.serviceUrl('machine-nas', 'dns', dns)).rejects.toThrow('nas is stopped until something runs on it');
  });
});
