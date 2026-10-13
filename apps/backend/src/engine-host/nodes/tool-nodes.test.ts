import { describe, it, expect } from 'vitest';
import type { AgentDefinition } from '@koala/agent-engine';
import { createToolNodes } from './tool-nodes.js';
import { createAgentRegistry } from '../registries/registry.js';
import { createServerTools } from '../tools/server-tools.js';
import { runsFingerprint, type McpServerRecord, type ServerRuns } from '../../lib/mcp-servers.js';
import type { McpTool } from '../../lib/mcp-client.js';

const koala: AgentDefinition = {
  slug: 'koala', name: 'Koala', description: 'talks', version: '1', prompt: 'p', guidance: '', returns: '', failures: [],
  procedure: 'tool-rounds', tools: [], environment: {},
};

const HOSTED: ServerRuns = { where: 'hosted', url: 'http://gitea.test/mcp' };
const WORKSPACE: ServerRuns = { where: 'workspace', install: [{ via: 'npm', packages: ['echoes'] }], start: 'echoes', port: 8931 };
const record = (name: string, runs: ServerRuns, tools: McpTool[]): McpServerRecord => ({
  id: name, ownerId: 'u1', name, runs, createdAt: 't0', updatedAt: 't0', captured: { tools, at: 't1', fingerprint: runsFingerprint(runs) },
});
const CATALOGUE = [
  record('gitea', HOSTED, [{ name: 'list_repos', annotations: { readOnlyHint: true } }, { name: 'create_issue' }]),
  record('echoes', WORKSPACE, [{ name: 'echo', description: 'Echo' }]),
];

const serverTools = (enabled: string[]) => createServerTools({
  catalogue: async () => CATALOGUE,
  enabled: async () => enabled,
  hosted: { call: async () => ({ text: '', isError: false }) },
  workspace: { call: async () => ({ ok: true, digest: '' }) },
});

async function offered(persona: AgentDefinition, { enabled = [], environment, settings = {} }: { enabled?: string[]; environment?: unknown; settings?: Record<string, unknown> } = {}) {
  const [node] = createToolNodes({
    registry: createAgentRegistry({ agentStore: { list: async () => [persona] }, toolCatalogue: { list: async () => [] } }),
    serverTools: serverTools(enabled),
  });
  const out = await (node!.run as (request: unknown) => Promise<{ outputs: { offered: { name: string; openWorld?: boolean }[]; withheld: { name: string; why: string }[] } }>)({
    node: { id: 'tools', settings },
    inputs: { persona, ...(environment ? { environment } : {}) },
    run: { identity: { runId: 'r1', depth: 0, agentId: persona.slug }, launch: { ownerId: 'u1', conversationId: 'c1' }, handles: {} },
  });
  return out.outputs;
}

describe('resolve-tools with MCP servers', () => {
  it('offers the tools of a server switched on for the conversation, and none otherwise', async () => {
    expect((await offered(koala)).offered).toEqual([]);
    expect((await offered(koala, { enabled: ['gitea'] })).offered.map((tool) => tool.name)).toEqual(['gitea__list_repos', 'gitea__create_issue']);
  });

  it('withholds what a read-only persona may not do, and says the results come from outside', async () => {
    const out = await offered({ ...koala, maxEffect: 'read' }, { enabled: ['gitea'] });
    expect(out.offered.map((tool) => tool.name)).toEqual(['gitea__list_repos']);
    expect(out.offered[0]!.openWorld).toBe(true);
    expect(out.withheld.map((tool) => tool.name)).toEqual(['gitea__create_issue']);
  });

  it('offers the servers an agent holds, a workspace one only in a workspace', async () => {
    const executor: AgentDefinition = { ...koala, slug: 'executor', servers: ['echoes'], environment: { terminal: true, filesystem: true } };
    const sandbox = { kind: 'sandbox', id: 'sb-1', spec: { kind: 'sandbox', lifecycle: 'invocation' }, capabilities: { kind: 'sandbox', lifecycle: 'invocation' } };
    expect((await offered(executor, { environment: sandbox })).offered.map((tool) => tool.name)).toEqual(['echoes__echo']);
    expect((await offered(executor)).withheld).toEqual([{ name: 'echoes', why: 'it runs in a workspace, and this run has none' }]);
  });

  it('offers no server\'s tools to a step that offers no tools, and only the chosen ones to a step that chooses', async () => {
    expect((await offered(koala, { enabled: ['gitea'], settings: { offer: 'none' } })).offered).toEqual([]);
    expect((await offered(koala, { enabled: ['gitea'], settings: { offer: 'chosen', chosen: ['gitea__list_repos'] } })).offered.map((tool) => tool.name)).toEqual(['gitea__list_repos']);
  });
});
