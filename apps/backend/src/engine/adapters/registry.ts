import { resolveAgent, visibleAgents, type AgentDefinition } from '../agent.js';
import { withBuiltIns } from '../../lib/ownership.js';
import { SEEDED_AGENTS, SEEDED_LOOPS } from '../seeds.js';
import { contractsFor } from '../catalogue.js';
import { BUILDER_TOOLS } from '../builder-tools-catalogue.js';
import type { LoopGraph } from '../graph.js';
import type { ToolContract } from '@koala/engine-core';

export interface AgentStore {
  list(ownerId: string): Promise<AgentDefinition[]>;
}

export interface LoopStore {
  list(ownerId: string): Promise<LoopGraph[]>;
}

export interface ToolCatalogue {
  list(ownerId: string): Promise<ToolContract[]>;
}

export interface Runnable {
  agent: AgentDefinition;
  graph: LoopGraph;
}

export interface AgentRegistry {
  agents(ownerId: string): Promise<AgentDefinition[]>;
  agent(ownerId: string, slug: string): Promise<AgentDefinition | undefined>;
  loop(ownerId: string, id: string): Promise<LoopGraph | undefined>;
  runnable(ownerId: string, slug: string): Promise<Runnable | undefined>;
  tools(ownerId: string): Promise<ToolContract[]>;
  callable(ownerId: string, slug: string): Promise<AgentDefinition[]>;
}

export interface RegistryOptions {
  agentStore?: AgentStore | undefined;
  loopStore?: LoopStore | undefined;
  toolCatalogue?: ToolCatalogue | undefined;
}

const seededAgentStore: AgentStore = { list: async () => [...SEEDED_AGENTS] };
const seededLoopStore: LoopStore = { list: async () => [...SEEDED_LOOPS] };
const seededToolCatalogue: ToolCatalogue = { list: async () => contractsFor(BUILDER_TOOLS) };

type OwnedLoop = LoopGraph & { ownerId?: string | undefined };

export function createAgentRegistry(options: RegistryOptions = {}): AgentRegistry {
  const agentStore = options.agentStore ?? seededAgentStore;
  const loopStore = options.loopStore ?? seededLoopStore;
  const toolCatalogue = options.toolCatalogue ?? seededToolCatalogue;

  const agents = async (ownerId: string): Promise<AgentDefinition[]> =>
    visibleAgents(await agentStore.list(ownerId), ownerId);

  const agent = async (ownerId: string, slug: string): Promise<AgentDefinition | undefined> =>
    resolveAgent(await agentStore.list(ownerId), ownerId, slug);

  const loop = async (ownerId: string, id: string): Promise<LoopGraph | undefined> => {
    const all = (await loopStore.list(ownerId)) as OwnedLoop[];
    return withBuiltIns(all, ownerId, (graph) => graph.id).find((graph) => graph.id === id);
  };

  return {
    agents,
    agent,
    loop,

    async runnable(ownerId: string, slug: string): Promise<Runnable | undefined> {
      const found = await agent(ownerId, slug);
      if (!found) return undefined;
      const graph = await loop(ownerId, found.loop);
      if (!graph) return undefined;
      return { agent: found, graph };
    },

    async tools(ownerId: string): Promise<ToolContract[]> {
      return toolCatalogue.list(ownerId);
    },

    async callable(ownerId: string, slug: string): Promise<AgentDefinition[]> {
      const found = await agent(ownerId, slug);
      if (!found) return [];
      const allowed = new Set(found.agents ?? []);
      return (await agents(ownerId)).filter((candidate) => allowed.has(candidate.slug));
    },
  };
}
