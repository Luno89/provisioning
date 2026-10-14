import { describe, it, expect } from 'vitest';
import type { ActionProposal, McpRequest } from '@koala/harness-types';
import { MCP_SERVER_TEMPLATES } from '../../extensions/mcp/templates.js';
import type { AgentDefinition } from '@koala/agent-engine';
import { createMcpRequestTools } from './mcp-tools.js';
import { createServerTools } from './server-tools.js';
import { createToolRuntime } from './tool-runtime.js';
import { createAgentRegistry } from '../registries/registry.js';
import { runsFingerprint, type McpServerRecord, type ServerRuns } from '../../lib/mcp-servers.js';

const HOSTED: ServerRuns = { where: 'hosted', url: 'http://x/mcp' };
const GITEA: McpServerRecord = {
  id: 'd1', ownerId: 'u1', name: 'gitea', runs: HOSTED, createdAt: 't0', updatedAt: 't0',
  captured: {
    tools: [
      { name: 'list_repos', description: 'List repositories', annotations: { readOnlyHint: true, idempotentHint: true } },
      { name: 'create_issue', description: 'Open an issue' },
    ],
    at: 't1',
    fingerprint: runsFingerprint(HOSTED),
  },
};

function world(enabled: string[] = [], catalogue: McpServerRecord[] = [GITEA]) {
  const calls: string[] = [];
  const requests: McpRequest[] = [];
  const stores = {
    enabled: async () => enabled,
    requests: { list: async () => requests, save: async (request: McpRequest) => { requests.push(request); } },
  };
  const serverTools = createServerTools({
    catalogue: async () => catalogue,
    enabled: stores.enabled,
    hosted: { call: async (_owner, _runs, tool) => { calls.push(tool); return { text: `${tool} ran`, isError: false }; } },
  });
  return { stores, calls, requests, serverTools, catalogue };
}

const persona = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  slug: 'koala', name: 'Koala', description: 'talks', version: '1', prompt: 'p', guidance: '', returns: '', failures: [],
  procedure: 'tool-rounds', tools: [], environment: {}, ...over,
});

const runtime = (agent: AgentDefinition, w: ReturnType<typeof world>) => createToolRuntime({
  registry: createAgentRegistry({ agentStore: { list: async () => [agent] }, toolCatalogue: { list: async () => [] } }),
  serverTools: w.serverTools,
});

const call = (name: string, conversationId?: string, attempt = 1, agent = persona()) => (tools: ReturnType<typeof runtime>) =>
  tools.run({ ticket: { runId: 'r', depth: 0, ownerId: 'u1', agentSlug: agent.slug, trigger: 'user', ...(conversationId ? { conversationId } : {}) }, nodeId: 'n', name, arguments: '{}' }, attempt);

describe('MCP tools for a run', () => {
  it('runs nothing when no server is held or switched on', async () => {
    const w = world();
    const out = await call('gitea__list_repos', 'c1')(runtime(persona(), w));
    expect(out.ok).toBe(false);
    expect(w.calls).toEqual([]);
  });

  it('runs a server switched on for the conversation', async () => {
    const w = world(['gitea']);
    expect(await call('gitea__list_repos', 'c1')(runtime(persona(), w))).toMatchObject({ ok: true, digest: 'list_repos ran' });
    expect(w.calls).toEqual(['list_repos']);
  });

  it('runs a server the agent holds, with no conversation at all', async () => {
    const agent = persona({ slug: 'executor', servers: ['gitea'] });
    expect((await call('gitea__create_issue', undefined, 1, agent)(runtime(agent, world()))).ok).toBe(true);
  });

  it('holds a read-only agent to the tools the server marks read-only', async () => {
    const agent = persona({ slug: 'research', maxEffect: 'read', servers: ['gitea'] });
    const tools = runtime(agent, world());
    expect((await call('gitea__list_repos', undefined, 1, agent)(tools)).ok).toBe(true);
    const write = await call('gitea__create_issue', undefined, 1, agent)(tools);
    expect(write.ok).toBe(false);
  });

  it('does not repeat a tool the server never declared safe to repeat', async () => {
    const tools = runtime(persona(), world(['gitea']));
    expect((await call('gitea__create_issue', 'c1', 2)(tools)).digest).toContain('may already have run once');
    expect((await call('gitea__list_repos', 'c1', 2)(tools)).ok).toBe(true);
  });
});

describe('enable_mcp_server', () => {
  const ask = (w: ReturnType<typeof world>, parsed: Record<string, unknown>, conversationId: string | null = 'c1') =>
    createMcpRequestTools({ catalogue: async () => w.catalogue, stores: w.stores, newId: () => 'q1', now: () => 't' }).enable_mcp_server!({
      name: 'enable_mcp_server', parsed, driver: undefined, caller: { ownerId: 'u1', ...(conversationId !== null ? { conversationId } : {}) },
    });

  it('asks once for a server that exists', async () => {
    const w = world();
    expect((await ask(w, { server: 'Gitea', why: 'to read the repo' })).content).toContain('Asked the person to switch gitea on');
    expect((await ask(w, { server: 'gitea', why: 'again' })).content).toContain('Already asked');
    expect(w.requests).toMatchObject([{ server: 'gitea', status: 'requested', conversationId: 'c1', why: 'to read the repo' }]);
  });

  it('names the real servers when asked for one that does not exist, and needs a conversation and a reason', async () => {
    const w = world();
    expect((await ask(w, { server: 'Jira', why: 'x' })).digest).toContain('the ones that are: gitea');
    expect((await ask(w, { server: 'gitea' })).digest).toContain('say why');
    expect((await ask(w, { server: 'gitea', why: 'x' }, null)).digest).toContain('switched on for a conversation');
    expect((await ask(world([], [{ ...GITEA, captured: undefined }]), { server: 'gitea', why: 'x' })).digest).toContain('the ones that are: none');
    expect(w.requests).toEqual([]);
  });

  it('says so when the server is already on', async () => {
    expect((await ask(world(['gitea']), { server: 'gitea', why: 'x' })).content).toContain('already switched on');
  });
});

describe('list_mcp_servers and propose_mcp_server', () => {
  const tools = (proposals: ActionProposal[]) => {
    const w = world();
    return createMcpRequestTools({
      catalogue: async () => w.catalogue,
      stores: w.stores,
      proposing: {
        templates: () => MCP_SERVER_TEMPLATES,
        agents: async () => [{ slug: 'koala', servers: ['gitea'] }, { slug: 'executor' }],
        proposals: { list: async () => proposals, save: async (proposal) => { proposals.push(proposal); } },
      },
      newId: () => `a${proposals.length + 1}`,
      now: () => 't',
    });
  };
  const call = (handlers: ReturnType<typeof tools>, name: string, parsed: Record<string, unknown>) =>
    handlers[name]!({ name, parsed, driver: undefined, caller: { ownerId: 'u1', conversationId: 'c1', runId: 'r1' } } as never);

  it('lists the person\'s servers with their state and who holds them, and the known ones not added', async () => {
    const out = await call(tools([]), 'list_mcp_servers', {});
    expect(out.content).toBe([
      'YOUR MCP SERVERS', '',
      '- gitea', '  Runs hosted at http://x/mcp; captured, 2 tools offered: list_repos, create_issue', '  Held by: koala', '',
      'KNOWN SERVERS YOU CAN ADD', '',
      `- playwright: ${MCP_SERVER_TEMPLATES[0]!.summary} (runs in the workspace (node))`,
    ].join('\n'));
  });

  it('puts a proposal on a card in the conversation, once', async () => {
    const proposals: ActionProposal[] = [];
    const handlers = tools(proposals);
    const out = await call(handlers, 'propose_mcp_server', { template: 'playwright', agents: ['executor'], why: 'check Odoo pages' });
    expect(out).toMatchObject({ ok: true, content: 'Proposed on a card: add the MCP server playwright for executor. Nothing changes until the person applies it.' });
    expect(proposals).toEqual([expect.objectContaining({ id: 'a1', kind: 'add_mcp_server', status: 'proposed', conversationId: 'c1', runId: 'r1', summary: 'add the MCP server playwright for executor' })]);
    expect(JSON.parse(proposals[0]!.params.spec!)).toEqual({ template: 'playwright', name: 'playwright', agents: ['executor'], why: 'check Odoo pages' });

    expect((await call(handlers, 'propose_mcp_server', { template: 'playwright', agents: ['executor'], why: 'check Odoo pages' })).content).toMatch(/^This is already waiting for the person on a card/);
    expect(proposals).toHaveLength(1);
  });

  it('refuses what cannot be proposed, saying why', async () => {
    const out = await call(tools([]), 'propose_mcp_server', { server: 'gitea', agents: ['koala'], why: 'w' });
    expect(out).toMatchObject({ ok: false, content: 'koala already holds gitea; nothing was proposed' });
  });
});
