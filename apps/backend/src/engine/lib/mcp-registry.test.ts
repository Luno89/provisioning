import { describe, it, expect } from 'vitest';
import {
  looksLikeMcp, resolveForPersona, mcpGaps, describeServers, mcpUrlFor, mcpProbeUrlOf, type McpServer,
} from './mcp-registry.js';
import type { DeploymentMetadata } from '../../platform/lib/types.js';

const dep = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata =>
  ({ id: 'd1', name: 'weather', clusterId: 'c1', status: 'running', appType: 'gitapp', ...over } as DeploymentMetadata);

const server = (over: Partial<McpServer> = {}): McpServer =>
  ({ id: 'd1', name: 'weather', url: 'http://weather/mcp', tools: [{ name: 'get-forecast' }], ...over });

describe('what counts as a callable server', () => {
  it('takes a running Koala-built service', () => {
    expect(looksLikeMcp(dep())).toBe(true);
  });

  it('refuses one that is not running', () => {
    for (const status of ['deploying', 'destroyed', 'failed', 'destroying']) {
      expect(looksLikeMcp(dep({ status: status as never }))).toBe(false);
    }
  });

  it('refuses an app that is not one of ours', () => {
    expect(looksLikeMcp(dep({ appType: 'odoo' as never }))).toBe(false);
  });

  it('addresses the gitapp Service, not the deployment name', () => {
    expect(mcpUrlFor(dep({ name: 'koala-request-42784df9' } as never)))
      .toBe('http://gitapp.koala-request-42784df9.svc.cluster.local:8080/mcp');
  });

});

describe('where the backend asks a deployed MCP server', () => {
  const service = { spec: { ports: [{ name: 'http', port: 8080, nodePort: 31860 }] } };

  it('is the gitapp Service by name on Koala\'s own cluster, on the port it serves', () => {
    expect(mcpProbeUrlOf(service, 'tools-1a2b3c', { kind: 'koala' })).toBe('http://gitapp.tools-1a2b3c.svc.cluster.local:8080/mcp');
    expect(mcpProbeUrlOf({ spec: { ports: [{ port: 9000 }] } }, 'tools-1a2b3c', { kind: 'koala' })).toBe('http://gitapp.tools-1a2b3c.svc.cluster.local:9000/mcp');
  });

  it('is the machine\'s mesh address and the Service\'s node port on another machine', () => {
    expect(mcpProbeUrlOf(service, 'tools-1a2b3c', { kind: 'machine', clusterId: 'machine-desk', meshIp: '100.64.0.7' })).toBe('http://100.64.0.7:31860/mcp');
  });

  it('says why when there is no way to it', () => {
    expect(() => mcpProbeUrlOf({}, 'tools-1a2b3c', { kind: 'koala' })).toThrow('the MCP server in tools-1a2b3c serves no port');
    expect(() => mcpProbeUrlOf({ spec: { ports: [] } }, 'tools-1a2b3c', { kind: 'koala' })).toThrow('the MCP server in tools-1a2b3c serves no port');
    expect(() => mcpProbeUrlOf(service, 'tools-1a2b3c', { kind: 'machine', clusterId: 'machine-desk' })).toThrow('machine-desk has no mesh address, so Koala cannot reach the MCP server on it');
    expect(() => mcpProbeUrlOf({ spec: { ports: [{ port: 8080 }] } }, 'tools-1a2b3c', { kind: 'machine', clusterId: 'machine-desk', meshIp: '100.64.0.7' })).toThrow('the MCP server in tools-1a2b3c on machine-desk has no node port, so Koala cannot reach it from its own cluster');
  });
});

describe('which servers a persona gets', () => {
  it('gives it nothing unless it asked', () => {
    expect(resolveForPersona(undefined, [server()]).servers).toEqual([]);
    expect(resolveForPersona([], [server()]).servers).toEqual([]);
  });

  it('gives it the ones it named', () => {
    const out = resolveForPersona(['weather'], [server(), server({ id: 'd2', name: 'github' })]);
    expect(out.servers.map((s) => s.name)).toEqual(['weather']);
  });

  it('REPORTS a server it asked for and cannot have', () => {
    const out = resolveForPersona(['weather', 'gone'], [server()]);
    expect(out.servers.map((s) => s.name)).toEqual(['weather']);
    expect(out.missing).toEqual(['gone']);
  });
});

describe('where capability and network policy disagree', () => {
  it('flags a server the sandbox cannot actually reach', () => {
    const gaps = mcpGaps([server()], [{ namespace: 'gitea', ports: [3000] }], () => 'koala-apps');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('koala-apps');
    expect(gaps[0]).toMatch(/time out/);
  });

  it('says nothing when the egress allows it', () => {
    expect(mcpGaps([server()], [{ namespace: 'koala-apps', ports: [8080] }], () => 'koala-apps')).toEqual([]);
  });

  it('flags everything when a persona is sealed', () => {
    expect(mcpGaps([server()], [], () => 'koala-apps')).toHaveLength(1);
    expect(mcpGaps([server()], undefined, () => 'koala-apps')).toHaveLength(1);
  });
});

describe('telling the model what it can call', () => {
  it('names the service, not just the tools', () => {
    const text = describeServers([server({ tools: [{ name: 'get-forecast' }, { name: 'get-current' }] })]);
    expect(text).toContain('weather: get-forecast, get-current');
    expect(text).toMatch(/built and deployed by this harness/i);
    expect(text).toMatch(/Prefer calling one of these over rebuilding/i);
  });

  it('says nothing at all when there are none', () => {
    expect(describeServers([])).toBe('');
  });

  it('is honest about a server that reported no tools', () => {
    expect(describeServers([server({ tools: [] })])).toContain('no tools reported');
  });
});
