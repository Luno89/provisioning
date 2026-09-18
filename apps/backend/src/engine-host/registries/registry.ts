import {
  resolveAgent,
  visibleAgents,
  type AgentDefinition,
  type Persona,
  ALL_SEEDED_AGENTS,
  contractsFor,
  type ToolStatus,
  BUILDER_TOOLS,
} from '@koala/agent-engine';
import type { Procedure } from '@koala/agent-engine/procedure';
import { createStoredToolCatalogue, type ToolReader } from './tool-catalogue-store.js';
import { createProcedureStore, type OwnedProcedure, type ProcedureReader, type ProcedureStore } from './procedure-store.js';
import type { ToolContract } from '@koala/engine-core';

export interface AgentStore {
  list(ownerId: string): Promise<AgentDefinition[]>;
}

export interface ToolCatalogue {
  list(ownerId: string): Promise<ToolContract[]>;
}

export interface Runnable {
  agent: AgentDefinition;
  procedure: Procedure;
}

export interface AgentRegistry {
  agents(ownerId: string): Promise<AgentDefinition[]>;
  agent(ownerId: string, slug: string): Promise<AgentDefinition | undefined>;
  procedure(ownerId: string, id: string): Promise<OwnedProcedure | undefined>;
  procedures(ownerId: string): Promise<OwnedProcedure[]>;
  runnable(ownerId: string, slug: string, procedureId?: string): Promise<Runnable | undefined>;
  tools(ownerId: string): Promise<ToolContract[]>;
  callable(ownerId: string, slug: string): Promise<AgentDefinition[]>;
}

export interface RegistryOptions {
  agentStore?: AgentStore | undefined;
  procedureStore?: ProcedureStore | undefined;
  toolCatalogue?: ToolCatalogue | undefined;
}

export function createStoredAgentRegistry(options: {
  personas: { list(ownerId?: string): Promise<Persona[]> };
  procedures: ProcedureReader;
  tools?: ToolReader | undefined;
  include?: ToolStatus[] | undefined;
  toolCatalogue?: ToolCatalogue | undefined;
}): AgentRegistry {
  return createAgentRegistry({
    agentStore: {
      list: async (ownerId) => [
        ...ALL_SEEDED_AGENTS(),
        ...(await options.personas.list(ownerId)).filter((row) => row.ownerId !== undefined),
      ],
    },
    procedureStore: createProcedureStore({ sources: options.procedures }),
    ...(catalogueFor(options) ? { toolCatalogue: catalogueFor(options)! } : {}),
  });
}

function catalogueFor(options: {
  tools?: ToolReader | undefined;
  include?: ToolStatus[] | undefined;
  toolCatalogue?: ToolCatalogue | undefined;
}): ToolCatalogue | undefined {
  if (options.toolCatalogue) return options.toolCatalogue;
  if (!options.tools) return undefined;

  const stored = createStoredToolCatalogue({
    tools: options.tools,
    ...(options.include ? { include: options.include } : {}),
  });

  return { list: async (ownerId: string) => contractsFor(await stored.list(ownerId), ['draft', 'approved']) };
}

const seededAgentStore: AgentStore = { list: async () => ALL_SEEDED_AGENTS() };
const seededToolCatalogue: ToolCatalogue = { list: async () => contractsFor(BUILDER_TOOLS, ['draft', 'approved']) };

export function createAgentRegistry(options: RegistryOptions = {}): AgentRegistry {
  const agentStore = options.agentStore ?? seededAgentStore;
  const procedureStore = options.procedureStore ?? createProcedureStore({ sources: { list: async () => [] } });
  const toolCatalogue = options.toolCatalogue ?? seededToolCatalogue;

  const agents = async (ownerId: string): Promise<AgentDefinition[]> =>
    visibleAgents(await agentStore.list(ownerId), ownerId);

  const agent = async (ownerId: string, slug: string): Promise<AgentDefinition | undefined> =>
    resolveAgent(await agentStore.list(ownerId), ownerId, slug);

  return {
    agents,
    agent,
    procedure: (ownerId, id) => procedureStore.get(ownerId, id),
    procedures: (ownerId) => procedureStore.list(ownerId),

    async runnable(ownerId: string, slug: string, procedureId?: string): Promise<Runnable | undefined> {
      const found = await agent(ownerId, slug);
      if (!found) return undefined;

      const procedure = await procedureStore.get(ownerId, procedureId ?? found.procedure);
      if (!procedure) return undefined;

      return { agent: found, procedure };
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
