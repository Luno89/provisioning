import { BUILDER_TOOLS, type Persona, type ProcedureSource, type ToolDefinition } from '@koala/agent-engine';
import { BUILT_IN_SCENARIOS } from '../eval/level2/scenarios.js';
import { environmentHandlers, type EnvironmentDriver } from '@koala/engine-core';
import { createStoredAgentRegistry, type AgentRegistry } from './registries/registry.js';
import { treeTypeChoices } from '../lib/tree-types.js';
import { createStoredToolCatalogue, type StoredToolCatalogue } from './registries/tool-catalogue-store.js';
import { createEndpointResolver, type ModelServiceLike } from './registries/endpoints.js';
import { createRunEnvironments, type RunEnvironments } from './sandboxes/run-environments.js';
import { createSandboxDriver } from './drivers/sandbox.js';
import { createClusterBackend } from './sandboxes/cluster-backend.js';
import { createKubeRunner, createKubeStreamer } from './sandboxes/kube.js';
import { createWorkspaceDocuments, type DocumentRepos } from './sandboxes/workspace-documents.js';
import { repoForWorkspace } from './sandboxes/workspace-repos.js';
import { createImageBuilder, discoverRegistry, type ImageBuilder, type RegistryAccount } from './sandboxes/image-builder.js';
import { createEnvironmentResolver, type EnvironmentResolver } from './sandboxes/environments.js';
import { createTreeWorkspaces, type TreeWorkspaces } from './sandboxes/tree-workspaces.js';
import { createConversationWorkspaces, type ConversationWorkspaces } from './sandboxes/conversation-workspaces.js';
import { createMachineBackend } from './drivers/machine-backend.js';
import { createToolRuntime } from './tools/tool-runtime.js';
import { createEngineToolHandlers } from './tools/engine-tools.js';
import type { TaskStore } from './tools/task-tools.js';
import type { MemoryItem } from './drivers/memory-store.js';
import type { HostNodeServices } from './nodes/services.js';
import { extensionRuntimes, operationHandlers } from '../extensions/runtime.js';
import type { RunTicket, ToolRuntime } from './temporal/contracts.js';
import type { WebTools } from '../lib/web-tools.js';
import type { Database } from '../lib/db-interface.js';
import { createEffortTracker, type EffortTracker, type EffortTrackerOptions } from './registries/effort.js';
import { createCodeRunner } from './nodes/code-runner.js';
import { createWorkspaceImages, type WorkspaceImages } from './sandboxes/warm-images.js';
import { createImagePruner, type ImagePruner } from './sandboxes/prune-images.js';
import { createRegistryPackages } from './sandboxes/registry-packages.js';
import { createMcpToolSource } from './tools/mcp-tools.js';
import { proxyUrlFor } from '../lib/egress-proxy.js';

export interface EngineHostStores {
  personas: { list(ownerId?: string): Promise<Persona[]> };
  procedures: {
    list(ownerId?: string): Promise<ProcedureSource[]>;
    get(ownerId: string, id: string): Promise<ProcedureSource | undefined>;
    save(source: ProcedureSource): Promise<void>;
  };
  tools: { list(ownerId?: string): Promise<ToolDefinition[]> };
  tasks: TaskStore;
  grove: {
    trees: { list(): Promise<import('../lib/trees.js').Tree[]>; save(tree: import('../lib/trees.js').Tree): Promise<void> };
    branches: { list(): Promise<import('../lib/leaves.js').Branch[]>; save(branch: import('../lib/leaves.js').Branch): Promise<void> };
    leaves: { list(): Promise<import('../lib/leaves.js').Leaf[]>; save(leaf: import('../lib/leaves.js').Leaf): Promise<void> };
    /** optional: when absent, no leaf has tasks (P0 planner world) */
    tasks?: { list(): Promise<import('./tools/tasks.js').Task[]> };
    plans?: {
      save(proposal: import('../lib/plan-proposals.js').PlanProposal): Promise<void>;
      list(ownerId: string, conversationId?: string): Promise<import('../lib/plan-proposals.js').PlanProposal[]>;
    };
    treeTypes?: (ownerId: string) => Promise<import('../extensions/grove/tools/grove-tools.js').TreeTypeChoice[]>;
    binding?: (ownerId: string, conversationId: string) => Promise<{ treeId?: string | undefined; projectId?: string | undefined } | undefined>;
  };
  conversations: import('./nodes/conversation-nodes.js').ConversationStore;
  memories: {
    list(ownerId: string): Promise<MemoryItem[]>;
    save(item: MemoryItem): Promise<void>;
  };
  secrets?: import('./tools/secret-tools.js').SecretToolStores | undefined;
  mcp?: import('./tools/mcp-tools.js').McpToolStores | undefined;
  egress?: import('./tools/egress-tools.js').EgressToolStores | undefined;
  runs?: import('./tools/run-tools.js').RunReader | undefined;
  proposals?: {
    scenarioIds(ownerId: string): Promise<string[]>;
    list(ownerId: string): Promise<import('../lib/scenario-proposals.js').ScenarioProposal[]>;
    save(proposal: import('../lib/scenario-proposals.js').ScenarioProposal): Promise<void>;
  } | undefined;
  agentChanges?: {
    list(ownerId: string): Promise<import('../lib/agent-changes.js').AgentChange[]>;
    save(change: import('../lib/agent-changes.js').AgentChange): Promise<void>;
  } | undefined;
}

export interface EngineHostOptions {
  models: ModelServiceLike;
  stores: EngineHostStores;
  web?: WebTools | undefined;
  kubeconfig?: string | undefined;
  registryHost?: string | undefined;
  registryAccount?: (() => Promise<RegistryAccount>) | undefined;
  registryPushToken?: (() => Promise<{ username: string; password: string }>) | undefined;
  onSandbox?: ((driver: EnvironmentDriver, ticket: RunTicket) => Promise<void>) | undefined;
  onLeak?: ((runId: string, ageMs: number) => void) | undefined;
  efforts?: EffortTrackerOptions['store'] | undefined;
  vault?: import('./tools/secret-tools.js').SecretVault | undefined;
  mcp?: import('./tools/mcp-tools.js').McpAccess | undefined;
  kube?: import('./tools/kube-tools.js').KubeAccess | undefined;
  projects?: import('./tools/project-tools.js').ProjectToolStores | undefined;
  egressSecret?: string | undefined;
  corpus?: import('./tools/corpus-tools.js').CorpusAccess | undefined;
  /** Everyone whose agents could run, so the image sweep asks what each of them wants. */
  owners?: (() => Promise<string[]>) | undefined;
  hidden?: ((ownerId: string) => Promise<import('../lib/extension-settings.js').HiddenVocabulary>) | undefined;
  published?: ((ownerId: string) => Promise<import('@koala/agent-engine/procedure').GroupDefinition[]>) | undefined;
  documents?: DocumentRepos | undefined;
}

export interface EngineHost {
  efforts: EffortTracker | undefined;
  workspaceImages: WorkspaceImages;
  registry: AgentRegistry;
  catalogue: StoredToolCatalogue;
  endpoints: ReturnType<typeof createEndpointResolver>;
  environments: EnvironmentResolver;
  runEnvironments: RunEnvironments;
  treeWorkspaces: TreeWorkspaces;
  conversationWorkspaces: ConversationWorkspaces | undefined;
  images: ImageBuilder;
  /** Lets go of the workspace images nothing would run; absent where there is no registry account. */
  imagePruner: ImagePruner | undefined;
  tools: ToolRuntime;
  services: HostNodeServices;
  implemented: ReadonlySet<string>;
}

export function createEngineHost(options: EngineHostOptions): EngineHost {
  const { stores } = options;

  const catalogue = createStoredToolCatalogue({ tools: stores.tools });
  const registry = createStoredAgentRegistry({
    personas: stores.personas,
    procedures: stores.procedures,
    tools: stores.tools,
    ...(options.hidden ? { hidden: options.hidden } : {}),
    ...(options.published ? { published: options.published } : {}),
  });
  const endpoints = createEndpointResolver({ models: options.models, registry });
  const kube = createKubeRunner({ kubeconfig: options.kubeconfig });

  const documents = options.documents
    ? createWorkspaceDocuments({ kube, stream: createKubeStreamer({ kubeconfig: options.kubeconfig }), repos: options.documents })
    : undefined;
  const runEnvironments = createRunEnvironments({
    provision: async ({ ticket, spec, workspace, scope }) => {
      if (!workspace) throw new Error(`Run ${ticket.runId} asked for a sandbox without a resolved workspace spec.`);
      const driver = createSandboxDriver({
        sandboxId: workspace.runId,
        spec,
        ...(scope ? { scope } : {}),
        backend: createClusterBackend({
          run: kube,
          workspace,
          ...(documents && repoForWorkspace(workspace.runId)
            ? { onStarted: async () => { await documents.restore({ ownerId: ticket.ownerId, workspaceRunId: workspace.runId, ...repoForWorkspace(workspace.runId)! }); } }
            : {}),
        }),
      });
      await options.onSandbox?.(driver, ticket);
      return driver;
    },
    ...(options.onLeak ? { onLeak: options.onLeak } : {}),
  });

  const images = createImageBuilder({
    run: kube,
    ...(options.registryHost ? { registry: options.registryHost } : {}),
    ...(options.registryAccount ? { account: options.registryAccount } : {}),
    ...(options.registryPushToken ? { pushToken: options.registryPushToken } : {}),
  });

  const environments = createEnvironmentResolver({
    registry,
    environments: runEnvironments,
    images,
    tools: (ownerId: string) => catalogue.list(ownerId),
    machineBackend: createMachineBackend(),
    ...(stores.egress && options.egressSecret
      ? {
        egress: {
          grants: async (ownerId: string, agentSlug: string) => (await stores.egress!.grants(ownerId))
            .filter((grant) => grant.agentSlug === agentSlug && !grant.revokedAt)
            .map((grant) => ({ host: grant.host, ...(grant.ports ? { ports: grant.ports } : {}) })),
          proxyUrl: (ownerId: string, agentSlug: string) => proxyUrlFor(options.egressSecret!, ownerId, agentSlug),
        },
      }
      : {}),
  });

  const treeWorkspaces = createTreeWorkspaces({ resolver: environments, kube, documents });
  const conversationWorkspaces = documents
    ? createConversationWorkspaces({ resolver: environments, registry, kube, documents })
    : undefined;

  const web = options.web;
  const handlers = createEngineToolHandlers({
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
      groove: { stores: stores.grove },
      ...(stores.secrets ? { secrets: { stores: stores.secrets, ...(options.vault ? { vault: options.vault } : {}) } } : {}),
      ...(options.mcp && stores.mcp ? { mcp: { access: options.mcp, stores: stores.mcp } } : {}),
      ...(options.kube ? { kube: options.kube } : {}),
      ...(options.projects ? { projects: options.projects } : {}),
      ...(stores.egress ? { egress: stores.egress } : {}),
      ...(options.corpus ? { corpus: options.corpus } : {}),
      ...(stores.runs ? { runs: stores.runs } : {}),
      memories: stores.memories,
      ...(stores.proposals ? {
        scenarios: {
          known: async (ownerId: string) => ({
            agents: new Set((await registry.agents(ownerId)).map((agent) => agent.slug)),
            procedures: new Set((await registry.procedures(ownerId)).map((procedure) => procedure.id)),
            tools: await catalogue.list(ownerId),
          }),
          procedureOf: async (ownerId: string, slug: string) => (await registry.agents(ownerId)).find((agent) => agent.slug === slug)?.procedure,
          scenarioIds: stores.proposals.scenarioIds,
          proposals: { list: stores.proposals.list, save: stores.proposals.save },
        },
      } : {}),
      ...(stores.agentChanges ? {
        agentChanges: {
          agent: async (ownerId: string, slug: string) => {
            const found = (await registry.agents(ownerId)).find((agent) => agent.slug === slug);
            return found ? { prompt: found.prompt, procedure: found.procedure } : undefined;
          },
          procedures: async (ownerId: string) => (await registry.procedures(ownerId)).map((procedure) => procedure.id),
          changes: stores.agentChanges,
        },
      } : {}),
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
      },
  });

  const mcp = options.mcp && stores.mcp ? createMcpToolSource({ access: options.mcp, stores: stores.mcp }) : undefined;
  const tools = createToolRuntime({ registry, environments, handlers, ...(mcp ? { mcp } : {}) });

  const efforts = options.efforts
    ? createEffortTracker({ models: options.models, registry, store: options.efforts })
    : undefined;

  const services: HostNodeServices = {
    registry,
    models: options.models,
    tools,
    environments,
    ...(efforts ? { efforts } : {}),
    images: { waiting: (ownerId: string, agentSlug: string) => workspaceImages.waiting(ownerId, agentSlug) },
    code: createCodeRunner({ environments: { forRun: (request) => environments.forRun(request) } }),
    conversations: stores.conversations,
    ...(conversationWorkspaces ? { conversationWorkspaces } : {}),
    ...(mcp ? { mcp } : {}),
    memories: {
      list: async (ownerId: string) => (await stores.memories.list(ownerId)).filter((memory) => memory.ownerId === ownerId),
      save: stores.memories.save,
    },
    ...(options.hidden ? { hidden: options.hidden } : {}),
    operations: operationHandlers(extensionRuntimes({ grove: { operations: {
      trees: stores.grove.trees,
      branches: stores.grove.branches,
      leaves: stores.grove.leaves,
      tasks: stores.tasks,
      plans: { list: async (ownerId: string) => (await stores.grove.plans?.list(ownerId)) ?? [] },
      treeWorkspaces,
      environments,
      registry,
    } } })),
  };

  const workspaceImages: WorkspaceImages = createWorkspaceImages({
    images,
    personas: (ownerId?: string) => registry.agents(ownerId ?? ''),
    tools: (ownerId?: string) => stores.tools.list(ownerId),
    ...(options.owners ? { owners: options.owners } : {}),
  });

  const registryAccount = options.registryAccount;
  // The registry's package API is served at the same address the builds push to, so the sweep asks there.
  let registryAddress: string | undefined;
  const registryPackages = registryAccount
    ? createRegistryPackages({
      registry: async () => (registryAddress ??= options.registryHost ?? await discoverRegistry(kube)),
      account: registryAccount,
    })
    : undefined;
  const imagePruner = registryPackages
    ? createImagePruner({
      tags: () => registryPackages.list(),
      wanted: () => workspaceImages.wanted(),
      remove: (fingerprint: string) => registryPackages.remove(fingerprint),
    })
    : undefined;

  const implemented = new Set([...Object.keys(environmentHandlers), ...Object.keys(handlers)]);

  return {
    efforts, workspaceImages, registry, catalogue, endpoints, environments,
    runEnvironments, treeWorkspaces, conversationWorkspaces, images, imagePruner, tools, services, implemented,
  };
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
    conversations: {
      get: (ownerId, id) => db.getConversation(ownerId, id),
      save: (conversation) => db.saveConversation(conversation),
    },
    tasks: { list: (ownerId: string) => db.getTasks(ownerId), save: (task) => db.saveTask(task) },
    grove: {
      trees: { list: () => db.getTrees(), save: (tree) => db.saveTree(tree) },
      branches: { list: () => db.getBranches(), save: (branch) => db.saveBranch(branch) },
      leaves: { list: () => db.getLeaves(), save: (leaf) => db.saveLeaf(leaf) },
      tasks: { list: () => db.getTasks() },
      plans: {
        save: (proposal) => db.savePlanProposal(proposal),
        list: (ownerId, conversationId) => db.getPlanProposals(ownerId, conversationId),
      },
      treeTypes: async (ownerId: string) => treeTypeChoices(await db.getTreeTypes(ownerId), ownerId),
      binding: async (ownerId: string, conversationId: string) => {
        const conversation = await db.getConversation(ownerId, conversationId);
        return conversation ? { treeId: conversation.treeId, projectId: conversation.projectId } : undefined;
      },
    },
    memories: { list: (ownerId: string) => db.getMemories(ownerId), save: (item: MemoryItem) => db.saveMemory(item) },
    egress: {
      grants: (ownerId: string) => db.getEgressGrants(ownerId),
      requests: { list: (ownerId: string) => db.getEgressRequests(ownerId), save: (request) => db.saveEgressRequest(request) },
      trees: { list: () => db.getTrees() },
    },
    mcp: {
      enabled: async (ownerId: string, conversationId: string) => (await db.getConversation(ownerId, conversationId))?.mcpServers ?? [],
      requests: {
        list: (ownerId: string, conversationId: string) => db.getMcpRequests(ownerId, conversationId),
        save: (request) => db.saveMcpRequest(request),
      },
    },
    secrets: {
      requests: {
        list: (ownerId, filter) => db.getSecretRequests(ownerId, filter),
        save: (request) => db.saveSecretRequest(request),
      },
      projects: { list: () => db.getProjects(), save: (project) => db.saveProject(project) },
      trees: { list: () => db.getTrees() },
      binding: async (ownerId: string, conversationId: string) => {
        const conversation = await db.getConversation(ownerId, conversationId);
        return conversation ? { treeId: conversation.treeId, projectId: conversation.projectId } : undefined;
      },
    },
    runs: { traces: (ownerId: string, runId: string) => db.getRunTraces(ownerId, runId) },
    proposals: {
      scenarioIds: async (ownerId: string) => [
        ...BUILT_IN_SCENARIOS.map((scenario) => scenario.id),
        ...(await db.getEvalRecords<{ id: string; ownerId: string }>('evalScenarios', ownerId, 1000)).map((scenario) => scenario.id),
      ],
      list: (ownerId: string) => db.getEvalRecords('evalScenarioProposals', ownerId, 1000),
      save: (proposal) => db.saveEvalRecord('evalScenarioProposals', proposal),
    },
    agentChanges: {
      list: (ownerId: string) => db.getEvalRecords('evalAgentChanges', ownerId, 1000),
      save: (change) => db.saveEvalRecord('evalAgentChanges', change),
    },
  };
}
