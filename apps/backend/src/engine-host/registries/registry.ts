import { SwitchedOffError, switchedOffProblems, type HiddenVocabulary } from '../../lib/extension-settings.js';
import { referencedPublished } from '../../lib/authored-extensions.js';
import type { GroupDefinition } from '@koala/agent-engine/procedure';
import {
  resolveAgent,
  visibleAgents,
  type AgentDefinition,
  type Persona,
  contractsFor,
  BUILDER_TOOLS,
} from '@koala/agent-engine';
import type { Procedure } from '@koala/agent-engine/procedure';
import { createStoredToolCatalogue, type ToolReader } from './tool-catalogue-store.js';
import { createProcedureStore, type OwnedProcedure, type ProcedureReader, type ProcedureStore } from './procedure-store.js';
import type { ToolContract } from '@koala/engine-core';
import { seededPersonas } from '../../extensions/seeds.js';

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

export async function withPublished(procedure: Procedure, published: readonly GroupDefinition[]): Promise<Procedure> {
  const own = new Set(procedure.groups.map((group) => group.id));
  const wanted = referencedPublished(procedure).filter((id) => !own.has(id));
  if (wanted.length === 0) return procedure;
  const byId = new Map(published.map((group) => [group.id, group]));
  return { ...procedure, groups: [...procedure.groups, ...wanted.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))] };
}

export function createStoredAgentRegistry(options: {
  personas: { list(ownerId?: string): Promise<Persona[]> };
  procedures: ProcedureReader;
  tools?: ToolReader | undefined;
  toolCatalogue?: ToolCatalogue | undefined;
  hidden?: ((ownerId: string) => Promise<HiddenVocabulary>) | undefined;
  published?: ((ownerId: string) => Promise<GroupDefinition[]>) | undefined;
}): AgentRegistry {
  const hiddenFor = async (ownerId: string | undefined) => (ownerId && options.hidden ? options.hidden(ownerId) : undefined);
  const tools = catalogueFor(options);
  const registry = createAgentRegistry({
    agentStore: {
      list: async (ownerId) => {
        const hidden = await hiddenFor(ownerId);
        return [
          ...seededPersonas().filter((persona) => !hidden?.agents.has(persona.slug)),
          ...(await options.personas.list(ownerId)).filter((row) => row.ownerId !== undefined && !hidden?.agents.has(row.slug)),
        ];
      },
    },
    procedureStore: createProcedureStore({ sources: options.procedures, ...(options.published ? { published: options.published } : {}) }),
    ...(tools ? {
      toolCatalogue: {
        list: async (ownerId: string) => {
          const hidden = await hiddenFor(ownerId);
          return (await tools.list(ownerId)).filter((tool) => !hidden?.tools.has(tool.name));
        },
      },
    } : {}),
  });
  if (!options.published && !options.hidden) return registry;
  return {
    ...registry,
    async runnable(ownerId: string, slug: string, procedureId?: string) {
      const found = await registry.runnable(ownerId, slug, procedureId);
      if (!found) return found;
      const hidden = await hiddenFor(ownerId);
      const refused = hidden ? switchedOffProblems(found.procedure, hidden) : [];
      if (refused.length > 0) throw new SwitchedOffError(found.procedure.id, refused);
      return options.published ? { ...found, procedure: await withPublished(found.procedure, await options.published(ownerId)) } : found;
    },
  };
}

function catalogueFor(options: {
  tools?: ToolReader | undefined;
  toolCatalogue?: ToolCatalogue | undefined;
}): ToolCatalogue | undefined {
  if (options.toolCatalogue) return options.toolCatalogue;
  if (!options.tools) return undefined;

  const stored = createStoredToolCatalogue({ tools: options.tools });

  return { list: async (ownerId: string) => contractsFor(await stored.list(ownerId)) };
}

const seededAgentStore: AgentStore = { list: async () => seededPersonas() };
const seededToolCatalogue: ToolCatalogue = { list: async () => contractsFor(BUILDER_TOOLS) };

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
