import { describe, expect, it } from 'vitest';
import { hostedMcpUrl } from './mcp-hosted-url.js';

describe('the address of a hosted MCP server', () => {
  const resolve = hostedMcpUrl({
    deployments: async () => [{ id: 'd1', name: 'tools', namespace: 'tools-1a2b3c', ownerId: 'u1', status: 'running' }],
    probeUrl: async (namespace) => `http://tools.${namespace}.svc:8080/mcp`,
    urlProblem: async (url) => (url.includes('169.254') ? '169.254.169.254 is a private, loopback, mesh or reserved address' : undefined),
  });

  it('is a URL on the open internet when the person gave one', async () => {
    expect(await resolve('u1', { where: 'hosted', url: 'https://mcp.example.com/mcp' } as never)).toBe('https://mcp.example.com/mcp');
    await expect(resolve('u1', { where: 'hosted', url: 'http://169.254.169.254/latest' } as never)).rejects.toThrow('Koala reaches a hosted MCP server only on the open internet, and not this one: 169.254.169.254 is a private, loopback, mesh or reserved address');
  });

  it('is inside the cluster when it is one of the person\'s own deployments', async () => {
    expect(await resolve('u1', { where: 'hosted', deploymentId: 'd1' } as never)).toBe('http://tools.tools-1a2b3c.svc:8080/mcp');
  });
});
