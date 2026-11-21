import { describe, it, expect } from 'vitest';
import { contractFor, qualify, unqualify } from './mcp-tools.js';
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
