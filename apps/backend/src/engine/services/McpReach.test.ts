import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterAccess, Reach } from '../../infrastructure/index.js';
import { mcpReachFrom, type McpDeployment } from './McpReach.js';

const SERVICE = JSON.stringify({ spec: { ports: [{ name: 'http', port: 8080, nodePort: 31860 }] } });
const tools = (deployment: Partial<McpDeployment> = {}): McpDeployment => ({ id: 'd1', name: 'tools', namespace: 'tools-1a2b3c', clusterId: 'machine-desk', ...deployment });

const reaching = (reach: Reach) => {
  const access = mock<Pick<ClusterAccess, 'reach' | 'kubectl'>>();
  access.reach.calledWith(reach.clusterId).mockResolvedValue(reach);
  access.kubectl.mockImplementation(async (target, args) => {
    if (target !== reach || args.join(' ') !== 'get svc gitapp -n tools-1a2b3c -o json') throw new Error(`not asked: ${args.join(' ')}`);
    return SERVICE;
  });
  return access;
};

describe('where Koala asks a deployed MCP server', () => {
  it('is its gitapp Service by name when it runs on Koala\'s own cluster, read through ClusterAccess by the deployment\'s cluster', async () => {
    const access = reaching({ clusterId: 'machine-dev1', kind: 'koala' });
    const reach = mcpReachFrom({ access, clusterById: async () => undefined });
    expect(await reach.url(tools({ clusterId: 'machine-dev1' }))).toBe('http://gitapp.tools-1a2b3c.svc.cluster.local:8080/mcp');
  });

  it('is the machine\'s mesh address and the Service\'s node port on another machine', async () => {
    const access = reaching({ clusterId: 'machine-desk', kind: 'machine', kubeconfig: 'apiVersion: v1\n' });
    const reach = mcpReachFrom({ access, clusterById: async (id) => (id === 'machine-desk' ? { meshIp: '100.64.0.7' } : undefined) });
    expect(await reach.url(tools())).toBe('http://100.64.0.7:31860/mcp');
  });

  it('says why when there is no way to it, asking the cluster nothing it cannot', async () => {
    const access = mock<Pick<ClusterAccess, 'reach' | 'kubectl'>>();
    access.reach.calledWith('machine-desk').mockRejectedValue(new Error('desk is stopped until something runs on it'));
    access.reach.calledWith('root').mockResolvedValue({ clusterId: 'root', kind: 'root' });
    const reach = mcpReachFrom({ access, clusterById: async () => undefined });
    await expect(reach.url(tools())).rejects.toThrow('desk is stopped until something runs on it');
    await expect(reach.url(tools({ clusterId: 'root' }))).rejects.toThrow('root is root\'s own cluster, which runs no one\'s MCP server');
    expect(access.kubectl).not.toHaveBeenCalled();
  });

  it('says a machine with no mesh address cannot be reached', async () => {
    const access = reaching({ clusterId: 'machine-desk', kind: 'machine', kubeconfig: 'apiVersion: v1\n' });
    const reach = mcpReachFrom({ access, clusterById: async () => ({}) });
    await expect(reach.url(tools())).rejects.toThrow('machine-desk has no mesh address, so Koala cannot reach the MCP server on it');
  });

  it('probes by listing the server\'s tools, and turns any failure into the reason it is unreachable', async () => {
    const access = reaching({ clusterId: 'machine-desk', kind: 'machine', kubeconfig: 'apiVersion: v1\n' });
    const asked: string[] = [];
    const answering = (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push(String(url));
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      const result = body.method === 'tools/list' ? { tools: [{ name: 'a' }, { name: 'b' }] } : { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 's', version: '1' } };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }) as typeof fetch;
    const reach = mcpReachFrom({ access, clusterById: async () => ({ meshIp: '100.64.0.7' }), fetch: answering });
    expect(await reach.probe(tools())).toEqual({ tools: 2 });
    expect(asked.every((url) => url === 'http://100.64.0.7:31860/mcp')).toBe(true);
    const refusing = mcpReachFrom({ access, clusterById: async () => undefined });
    expect(await refusing.probe(tools())).toEqual({ unreachable: 'machine-desk has no mesh address, so Koala cannot reach the MCP server on it', tools: 0 });
  });
});
