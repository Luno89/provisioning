import { describe, it, expect } from 'vitest';
import type { AgentDefinition } from '@koala/agent-engine';
import { createToolNodes } from './tool-nodes.js';
import { createAgentRegistry } from '../registries/registry.js';
import { createMcpToolSource } from '../tools/mcp-tools.js';

const koala: AgentDefinition = {
  slug: 'koala', name: 'Koala', description: 'talks', version: '1', prompt: 'p', guidance: '', returns: '', failures: [],
  procedure: 'tool-rounds', tools: [], environment: {},
};

const mcp = (enabled: string[]) => createMcpToolSource({
  access: {
    servers: async () => [{ id: 'd1', name: 'Gitea MCP', url: 'u', tools: [{ name: 'list_repos', annotations: { readOnlyHint: true } }, { name: 'create_issue' }] }],
    call: async () => ({ text: '', isError: false }),
  },
  stores: { enabled: async () => enabled, requests: { list: async () => [], save: async () => undefined } },
});

async function offered(persona: AgentDefinition, enabled: string[]) {
  const [node] = createToolNodes({
    registry: createAgentRegistry({ agentStore: { list: async () => [persona] }, toolCatalogue: { list: async () => [] } }),
    mcp: mcp(enabled),
  });
  const out = await (node!.run as (request: unknown) => Promise<{ outputs: { offered: { name: string; openWorld?: boolean }[]; withheld: { name: string }[] } }>)({
    node: { id: 'tools', settings: {} },
    inputs: { persona },
    run: { launch: { ownerId: 'u1', conversationId: 'c1' }, handles: {} },
  });
  return out.outputs;
}

describe('resolve-tools with MCP servers', () => {
  it('offers the tools of a server switched on for the conversation, and none otherwise', async () => {
    expect((await offered(koala, [])).offered).toEqual([]);
    expect((await offered(koala, ['Gitea MCP'])).offered.map((tool) => tool.name)).toEqual(['gitea-mcp__list_repos', 'gitea-mcp__create_issue']);
  });

  it('withholds what a read-only persona may not do, and says the results come from outside', async () => {
    const out = await offered({ ...koala, maxEffect: 'read' }, ['Gitea MCP']);
    expect(out.offered.map((tool) => tool.name)).toEqual(['gitea-mcp__list_repos']);
    expect(out.offered[0]!.openWorld).toBe(true);
    expect(out.withheld.map((tool) => tool.name)).toEqual(['gitea-mcp__create_issue']);
  });
});
