import { describe, it, expect } from 'vitest';
import { withHints } from './mcp-tool-hints.js';
import { contractFor } from './mcp-tools.js';
import type { McpServer } from './mcp-registry.js';

const servers: McpServer[] = [{ id: 'd1', name: 'Gitea MCP', url: 'u', tools: [{ name: 'list_repos' }, { name: 'delete_repo', annotations: { idempotentHint: true } }] }];
const hint = (tool: string, choice: 'read-only' | 'safe-write' | 'destructive') => ({ ownerId: 'u1', server: 'Gitea MCP', tool, choice, updatedAt: 'x' });

describe('a person\'s word on what an MCP tool does', () => {
  it('turns a tool the server says nothing about into a read, so it stops asking', () => {
    const [server] = withHints(servers, [hint('list_repos', 'read-only')]);
    expect(contractFor('Gitea MCP', server!.tools[0]!)).toMatchObject({ effect: 'read', destructive: false });
  });

  it('keeps what the server did say, and remembers it next to the override', () => {
    const [server] = withHints(servers, [hint('delete_repo', 'safe-write')]);
    expect(server!.tools[1]).toMatchObject({ annotations: { idempotentHint: true, readOnlyHint: false, destructiveHint: false }, declared: { idempotentHint: true }, choice: 'safe-write' });
    expect(contractFor('Gitea MCP', server!.tools[1]!)).toMatchObject({ effect: 'write', destructive: false, idempotent: true });
  });

  it('leaves every tool nobody spoke about exactly as the server described it', () => {
    expect(withHints(servers, [])).toEqual(servers);
  });
});
