import { describe, it, expect, vi } from 'vitest';
import type { McpRequest } from '@koala/harness-types';
import type { AgentDefinition } from '@koala/agent-engine';
import { createMcpRequestTools, createMcpToolSource, type McpAccess } from './mcp-tools.js';
import { createToolRuntime } from './tool-runtime.js';
import { createAgentRegistry } from '../registries/registry.js';
import type { McpServer } from '../../lib/mcp-registry.js';

const GITEA: McpServer = {
  id: 'd1',
  name: 'Gitea MCP',
  url: 'http://x/mcp',
  tools: [
    { name: 'list_repos', description: 'List repositories', annotations: { readOnlyHint: true, idempotentHint: true } },
    { name: 'create_issue', description: 'Open an issue' },
  ],
};

function world(enabled: string[] = []) {
  const calls: string[] = [];
  const access: McpAccess = {
    servers: async () => [GITEA],
    call: vi.fn(async (_owner, server, tool) => { calls.push(`${server.name}/${tool}`); return { text: `${tool} ran`, isError: false }; }),
  };
  const requests: McpRequest[] = [];
  const stores = {
    enabled: async () => enabled,
    requests: { list: async () => requests, save: async (request: McpRequest) => { requests.push(request); } },
  };
  return { access, stores, calls, requests, source: createMcpToolSource({ access, stores }) };
}

const persona = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  slug: 'koala', name: 'Koala', description: 'talks', version: '1', prompt: 'p', guidance: '', returns: '', failures: [],
  procedure: 'tool-rounds', tools: [], environment: {}, ...over,
});

const runtime = (agent: AgentDefinition, source: ReturnType<typeof world>['source']) => createToolRuntime({
  registry: createAgentRegistry({ agentStore: { list: async () => [agent] }, toolCatalogue: { list: async () => [] } }),
  mcp: source,
});

const call = (name: string, conversationId?: string, attempt = 1, agent = persona()) => (tools: ReturnType<typeof runtime>) =>
  tools.run({ ticket: { runId: 'r', depth: 0, ownerId: 'u1', agentSlug: agent.slug, trigger: 'user', ...(conversationId ? { conversationId } : {}) }, nodeId: 'n', name, arguments: '{}' }, attempt);

describe('MCP tools for a run', () => {
  it('offers nothing and runs nothing when no server is granted or switched on', async () => {
    const w = world();
    expect((await w.source.forRun('u1', persona(), 'c1')).contracts).toEqual([]);
    const out = await call('gitea-mcp__list_repos', 'c1')(runtime(persona(), w.source));
    expect(out.ok).toBe(false);
    expect(w.calls).toEqual([]);
  });

  it('runs a server switched on for the conversation', async () => {
    const w = world(['Gitea MCP']);
    const out = await call('gitea-mcp__list_repos', 'c1')(runtime(persona(), w.source));
    expect(out).toMatchObject({ ok: true, digest: 'list_repos ran' });
    expect(w.calls).toEqual(['Gitea MCP/list_repos']);
  });

  it('runs a server the persona is granted, with no conversation at all', async () => {
    const agent = persona({ slug: 'executor', mcp: ['Gitea MCP'] });
    const w = world();
    const out = await call('gitea-mcp__create_issue', undefined, 1, agent)(runtime(agent, w.source));
    expect(out.ok).toBe(true);
  });

  it('holds a read-only persona to the tools the server marks read-only', async () => {
    const agent = persona({ slug: 'research', maxEffect: 'read', mcp: ['Gitea MCP'] });
    const w = world();
    const tools = runtime(agent, w.source);
    expect((await call('gitea-mcp__list_repos', undefined, 1, agent)(tools)).ok).toBe(true);
    const write = await call('gitea-mcp__create_issue', undefined, 1, agent)(tools);
    expect(write.ok).toBe(false);
    expect(write.digest).toContain('only reads');
  });

  it('does not repeat a tool the server never declared safe to repeat', async () => {
    const w = world(['Gitea MCP']);
    const tools = runtime(persona(), w.source);
    expect((await call('gitea-mcp__create_issue', 'c1', 2)(tools)).digest).toContain('may already have run once');
    expect((await call('gitea-mcp__list_repos', 'c1', 2)(tools)).ok).toBe(true);
  });
});

describe('enable_mcp_server', () => {
  const ask = (w: ReturnType<typeof world>, parsed: Record<string, unknown>, conversationId: string | null = 'c1') =>
    createMcpRequestTools({ access: w.access, stores: w.stores, newId: () => 'q1', now: () => 't' }).enable_mcp_server!({
      name: 'enable_mcp_server', parsed, driver: undefined, caller: { ownerId: 'u1', ...(conversationId !== null ? { conversationId } : {}) },
    });

  it('asks once for a server that exists', async () => {
    const w = world();
    expect((await ask(w, { server: 'gitea mcp', why: 'to read the repo' })).content).toContain('Asked the person to switch Gitea MCP on');
    expect((await ask(w, { server: 'Gitea MCP', why: 'again' })).content).toContain('Already asked');
    expect(w.requests).toMatchObject([{ server: 'Gitea MCP', status: 'requested', conversationId: 'c1', why: 'to read the repo' }]);
  });

  it('names the real servers when asked for one that does not exist, and needs a conversation and a reason', async () => {
    const w = world();
    expect((await ask(w, { server: 'Jira', why: 'x' })).digest).toContain('the servers this person runs are: Gitea MCP');
    expect((await ask(w, { server: 'Gitea MCP' })).digest).toContain('say why');
    expect((await ask(w, { server: 'Gitea MCP', why: 'x' }, null)).digest).toContain('switched on for a conversation');
    expect(w.requests).toEqual([]);
  });

  it('says so when the server is already on', async () => {
    expect((await ask(world(['Gitea MCP']), { server: 'Gitea MCP', why: 'x' })).content).toContain('already switched on');
  });
});
