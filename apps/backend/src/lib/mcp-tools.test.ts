import { describe, it, expect } from 'vitest';
import { contractFor, contractsFor, qualify, routeCall, serversFor, unqualify } from './mcp-tools.js';
import type { McpServer } from './mcp-registry.js';

const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: 'd1', name: 'Gitea MCP', url: 'http://x/mcp',
  tools: [{ name: 'list_repos', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, { name: 'create_issue' }],
  ...over,
});

describe('naming', () => {
  it('prefixes a tool with its server and reads it back', () => {
    expect(qualify('Gitea MCP', 'list_repos')).toBe('gitea-mcp__list_repos');
    expect(unqualify('gitea-mcp__list_repos')).toEqual({ server: 'gitea-mcp', tool: 'list_repos' });
    expect(unqualify('read_file')).toBeUndefined();
  });
});

describe('hints become declarations', () => {
  it('trusts a hint the server gives', () => {
    expect(contractFor('Gitea MCP', server().tools[0]!)).toMatchObject({ effect: 'read', idempotent: true, openWorld: false, destructive: false, binding: 'network' });
  });

  it('assumes the unsafe side when a hint is missing', () => {
    expect(contractFor('Gitea MCP', server().tools[1]!)).toMatchObject({ effect: 'write', idempotent: false, openWorld: true, destructive: true });
  });

  it('asks before a tool the server says is destructive, and only trusts a tool that writes when it says it is not', () => {
    expect(contractFor('Gitea MCP', { name: 'delete_repo', annotations: { destructiveHint: true } }).destructive).toBe(true);
    expect(contractFor('Gitea MCP', { name: 'add_label', annotations: { destructiveHint: false } }).destructive).toBe(false);
  });
});

describe('which servers a run gets', () => {
  it('keeps only named servers that answered with tools', () => {
    const down = server({ id: 'd2', name: 'Down', unreachable: 'timeout' });
    const empty = server({ id: 'd3', name: 'Empty', tools: [] });
    expect(serversFor(['Gitea MCP', 'Down', 'Empty'], [server(), down, empty]).map((s) => s.name)).toEqual(['Gitea MCP']);
    expect(contractsFor(serversFor(['Gitea MCP'], [server()])).map((c) => c.name)).toEqual(['gitea-mcp__list_repos', 'gitea-mcp__create_issue']);
  });

  it('routes a call only to a tool the server really has', () => {
    expect(routeCall('gitea-mcp__list_repos', [server()])).toMatchObject({ tool: 'list_repos' });
    expect(routeCall('gitea-mcp__drop_everything', [server()])).toBeUndefined();
    expect(routeCall('other__list_repos', [server()])).toBeUndefined();
  });
});
