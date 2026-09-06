import { describe, it, expect, vi } from 'vitest';
import { resolveMcpForLeaf } from './leaf-mcp.js';
import type { McpServer } from './mcp-registry.js';

const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: 's1', name: 'gitea-mcp', url: 'http://gitea-mcp/mcp',
  tools: [{ name: 'search_repos', description: 'd', inputSchema: {} }],
  ...over,
} as McpServer);

describe('resolveMcpForLeaf', () => {
  it('returns nothing when neither the pack nor the leaf names an MCP server', async () => {
    const registry = { listWithTools: vi.fn(), call: vi.fn() };
    const out = await resolveMcpForLeaf({ registry }, undefined, { id: 'l1' }, undefined);
    expect(out).toEqual({});
    expect(registry.listWithTools).not.toHaveBeenCalled();
  });

  it('offers tools from a wanted, reachable server', async () => {
    const registry = { listWithTools: vi.fn(async () => [server()]), call: vi.fn() };
    const out = await resolveMcpForLeaf({ registry }, { mcp: ['gitea-mcp'] }, { id: 'l1' }, undefined);

    expect(out.remoteToolNames).toEqual(['gitea-mcp__search_repos']);
    expect(typeof out.callRemote).toBe('function');
  });

  it('offers nothing from a server with no tools or that is unreachable', async () => {
    const registry = {
      listWithTools: vi.fn(async () => [server({ tools: [] }), server({ id: 's2', name: 'other', unreachable: 'timeout' })]),
      call: vi.fn(),
    };
    const out = await resolveMcpForLeaf({ registry }, { mcp: ['gitea-mcp', 'other'] }, { id: 'l1' }, undefined);
    expect(out).toEqual({});
  });

  it('routes a qualified tool call back through the registry', async () => {
    const registry = { listWithTools: vi.fn(async () => [server()]), call: vi.fn(async () => ({ text: 'ok', isError: false })) };
    const out = await resolveMcpForLeaf({ registry }, { mcp: ['gitea-mcp'] }, { id: 'l1' }, undefined);

    const result = await (out.callRemote as any)('gitea-mcp__search_repos', { q: 'x' });
    expect(result).toEqual({ text: 'ok', isError: false });
    expect(registry.call).toHaveBeenCalledWith(expect.objectContaining({ name: 'gitea-mcp' }), 'search_repos', { q: 'x' });
  });

  it('returns nothing, not a throw, when the registry itself fails', async () => {
    const registry = { listWithTools: vi.fn(async () => { throw new Error('down'); }), call: vi.fn() };
    const out = await resolveMcpForLeaf({ registry }, { mcp: ['gitea-mcp'] }, { id: 'l1' }, undefined);
    expect(out).toEqual({});
  });

  it('unions mcp servers named by the pack and named directly on the leaf', async () => {
    const registry = { listWithTools: vi.fn(async () => [server(), server({ id: 's2', name: 'other' })]), call: vi.fn() };
    const out = await resolveMcpForLeaf({ registry }, { mcp: ['gitea-mcp'] }, { id: 'l1', mcp: ['other'] }, undefined);
    expect((out.remoteToolNames as string[]).sort()).toEqual(['gitea-mcp__search_repos', 'other__search_repos']);
  });
});
