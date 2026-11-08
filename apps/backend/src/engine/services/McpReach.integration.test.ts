import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { encryptValue, nodeProcesses, nodeStreams, type ClusterMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { ClusterAccess } from '../../infrastructure/index.js';
import { TOOLS } from '../../infrastructure/testing/real-k3s.js';
import { mcpReachFrom } from './McpReach.js';

const KEY = 'test-key' as never;
const k3s = inject('k3s');

describe('reaching a person\'s MCP server through ClusterAccess', () => {
  it('finds it by its service name on Koala\'s own cluster, and at the mesh address and node port on another machine, reading the real Service', async () => {
    const db = await testDatabase();
    const namespace = `mcp-${randomUUID().slice(0, 6)}`;
    await db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'healthy', ownerId: 'bo', createdAt: 't', meshIp: '100.64.0.7', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata);
    await db.infrastructure.saveCluster({ id: 'machine-nas', name: 'nas', provider: 'machine', machineId: 'nas', status: 'stopped', ownerId: 'bo', createdAt: 't' } as ClusterMetadata);
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'dev1', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-mcp-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY, serviceAccount: k3s.account });
    await access.kubectl('machine-desk', ['create', 'namespace', namespace]);
    await access.kubectl('machine-desk', ['create', 'service', 'nodeport', 'gitapp', '-n', namespace, '--tcp=8080:8080']);
    const nodePort = Number(await access.kubectl('machine-desk', ['get', 'service', 'gitapp', '-n', namespace, '-o', 'jsonpath={.spec.ports[0].nodePort}']));
    const reach = mcpReachFrom({ access, clusterById: async (id) => (await db.infrastructure.getClusters()).find((cluster) => cluster.id === id) });
    const tools = (clusterId: string) => ({ id: `d-${clusterId}`, name: 'tools', namespace, clusterId });

    expect(await reach.url(tools('machine-desk'))).toBe(`http://100.64.0.7:${nodePort}/mcp`);
    expect(await reach.url(tools('machine-dev1'))).toBe(`http://gitapp.${namespace}.svc.cluster.local:8080/mcp`);
    await expect(reach.url(tools('machine-nas'))).rejects.toThrow('nas is stopped until something runs on it');
    await expect(reach.url(tools('machine-gone'))).rejects.toThrow('there is no cluster machine-gone');
    expect(await reach.probe(tools('machine-nas'))).toEqual({ unreachable: 'nas is stopped until something runs on it', tools: 0 });
  }, 120_000);
});
