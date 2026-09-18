import { BUILDER_TOOLS, type Persona, type ProcedureSource, type ToolDefinition } from '@koala/agent-engine';
import type { EnvironmentDriver } from '@koala/engine-core';
import { createStoredAgentRegistry, type AgentRegistry } from './registries/registry.js';
import { createStoredToolCatalogue, type StoredToolCatalogue } from './registries/tool-catalogue-store.js';
import { createEndpointResolver, type ModelServiceLike } from './registries/endpoints.js';
import { createRunEnvironments, type RunEnvironments } from './sandboxes/run-environments.js';
import { createSandboxDriver } from './drivers/sandbox.js';
import { createClusterBackend } from './sandboxes/cluster-backend.js';
import { createKubeRunner } from './sandboxes/kube.js';
import { createImageBuilder, type ImageBuilder } from './sandboxes/image-builder.js';
import { createEnvironmentResolver, type EnvironmentResolver } from './sandboxes/environments.js';
import { createMachineBackend } from './drivers/machine-backend.js';
import { createToolRuntime } from './tools/tool-runtime.js';
import { createEngineToolHandlers } from './tools/engine-tools.js';
import type { TaskStore } from './tools/task-tools.js';
import type { MemoryItem } from './drivers/memory-store.js';
import type { HostNodeServices } from './nodes/services.js';
import type { RunTicket, ToolRuntime } from './temporal/contracts.js';
import type { WebTools } from '../lib/web-tools.js';
import type { Database } from '../lib/db-interface.js';
import { createEffortTracker, type EffortTracker, type EffortTrackerOptions } from './registries/effort.js';

export interface EngineHostStores {
  personas: { list(ownerId?: string): Promise<Persona[]> };
  procedures: {
    list(ownerId?: string): Promise<ProcedureSource[]>;
    get(ownerId: string, id: string): Promise<ProcedureSource | undefined>;
    save(source: ProcedureSource): Promise<void>;
  };
  tools: { list(ownerId?: string): Promise<ToolDefinition[]> };
  tasks: TaskStore;
  memories: {
    list(ownerId: string): Promise<MemoryItem[]>;
    save(item: MemoryItem): Promise<void>;
  };
}

export interface EngineHostOptions {
  models: ModelServiceLike;
  stores: EngineHostStores;
  web?: WebTools | undefined;
  kubeconfig?: string | undefined;
  registryHost?: string | undefined;
  onSandbox?: ((driver: EnvironmentDriver, ticket: RunTicket) => Promise<void>) | undefined;
  onLeak?: ((runId: string, ageMs: number) => void) | undefined;
  efforts?: EffortTrackerOptions['store'] | undefined;
}

export interface EngineHost {
  efforts: EffortTracker | undefined;
  registry: AgentRegistry;
  catalogue: StoredToolCatalogue;
  endpoints: ReturnType<typeof createEndpointResolver>;
  environments: EnvironmentResolver;
  runEnvironments: RunEnvironments;
  images: ImageBuilder;
  tools: ToolRuntime;
  services: HostNodeServices;
}

export function createEngineHost(options: EngineHostOptions): EngineHost {
  const { stores } = options;

  const catalogue = createStoredToolCatalogue({ tools: stores.tools, include: ['draft', 'approved'] });
  const registry = createStoredAgentRegistry({
    personas: stores.personas,
    procedures: stores.procedures,
    tools: stores.tools,
    include: ['draft', 'approved'],
  });
  const endpoints = createEndpointResolver({ models: options.models, registry });
  const kube = createKubeRunner({ kubeconfig: options.kubeconfig });

  const runEnvironments = createRunEnvironments({
    provision: async ({ ticket, spec, workspace, scope }) => {
      if (!workspace) throw new Error(`Run ${ticket.runId} asked for a sandbox without a resolved workspace spec.`);
      const driver = createSandboxDriver({
        sandboxId: workspace.runId,
        spec,
        ...(scope ? { scope } : {}),
        backend: createClusterBackend({ run: kube, workspace }),
      });
      await options.onSandbox?.(driver, ticket);
      return driver;
    },
    ...(options.onLeak ? { onLeak: options.onLeak } : {}),
  });

  const images = createImageBuilder({ run: kube, ...(options.registryHost ? { registry: options.registryHost } : {}) });

  const environments = createEnvironmentResolver({
    registry,
    environments: runEnvironments,
    images,
    tools: (ownerId: string) => catalogue.list(ownerId),
    machineBackend: createMachineBackend(),
  });

  const web = options.web;
  const tools = createToolRuntime({
    registry,
    environments,
    handlers: createEngineToolHandlers({
      registry,
      images,
      catalogue: BUILDER_TOOLS,
      procedures: { get: stores.procedures.get, save: stores.procedures.save },
      scope: {
        procedures: (ownerId: string) => registry.procedures(ownerId),
        personas: (ownerId: string) => registry.agents(ownerId),
        toolNames: (ownerId: string) => catalogue.names(ownerId),
      },
      tasks: stores.tasks,
      platform: {
        ...(web
          ? {
            web: {
              search: async (query: string) => {
                const outcome = await web.search(query);
                return outcome.unavailable
                  ? { error: 'Search is unavailable — no backend could be reached. Rephrasing will not help.' }
                  : { results: outcome.hits };
              },
              fetchPage: (url: string) => web.readPage(url),
            },
          }
          : {}),
        memory: {
          remember: async (item: MemoryItem) => {
            await stores.memories.save(item);
            return { action: 'saved' };
          },
        },
      },
    }),
  });

  const efforts = options.efforts
    ? createEffortTracker({ models: options.models, registry, store: options.efforts })
    : undefined;

  const services: HostNodeServices = {
    registry,
    models: options.models,
    tools,
    environments,
    ...(efforts ? { efforts } : {}),
    memories: {
      list: async (ownerId: string) => (await stores.memories.list(ownerId)).filter((memory) => memory.ownerId === ownerId),
      save: stores.memories.save,
    },
  };

  return { efforts, registry, catalogue, endpoints, environments, runEnvironments, images, tools, services };
}

export function storesFromDatabase(db: Database): EngineHostStores {
  return {
    personas: { list: (ownerId?: string) => db.getEnginePersonas(ownerId) },
    procedures: {
      list: (ownerId?: string) => db.getProcedures(ownerId),
      get: (ownerId: string, id: string) => db.getProcedure(ownerId, id),
      save: (source: ProcedureSource) => db.saveProcedure(source),
    },
    tools: { list: (ownerId?: string) => db.getEngineTools(ownerId) },
    tasks: { list: (ownerId: string) => db.getTasks(ownerId), save: (task) => db.saveTask(task) },
    memories: { list: (ownerId: string) => db.getMemories(ownerId), save: (item: MemoryItem) => db.saveMemory(item) },
  };
}
