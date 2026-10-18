import { BUILDER_TOOLS, type Persona, type ProcedureSource, type ToolDefinition } from '@koala/agent-engine';
import { BUILT_IN_SCENARIOS } from '../eval/level2/scenarios.js';
import { environmentHandlers, type EnvironmentDriver } from '@koala/engine-core';
import { createAgentDirectory, grantStoreFrom, type AgentRecordStore, type ToolGrantStore } from './registries/agent-directory.js';
import { createStoredAgentRegistry, type AgentRegistry } from './registries/registry.js';
import { treeTypeChoices } from '../lib/tree-types.js';
import { createStoredToolCatalogue, type StoredToolCatalogue } from './registries/tool-catalogue-store.js';
import { createEndpointResolver, type ModelServiceLike } from './registries/endpoints.js';
import { createRunEnvironments, type RunEnvironments } from './sandboxes/run-environments.js';
import { createSandboxDriver } from './drivers/sandbox.js';
import { createClusterBackend } from './sandboxes/cluster-backend.js';
import { createKubeRunner, createKubeStreamer } from './sandboxes/kube.js';
import { createWorkspaceDocuments, type DocumentRepos } from './sandboxes/workspace-documents.js';
import { createMachineWork, type MachineWork } from './sandboxes/machine-work.js';
import { defaultRepoResolver, repoForWorkspace, treeWorkspaceRunId, type WorkspaceRepoResolver } from './sandboxes/workspace-repos.js';
import { createImageBuilder, discoverRegistry, type ImageBuilder, type RegistryAccount } from './sandboxes/image-builder.js';
import { createEnvironmentResolver, type EnvironmentResolver } from './sandboxes/environments.js';
import { createTreeWorkspaces, LANDING_BASE, type TreeWorkspaces } from './sandboxes/tree-workspaces.js';
import { createConversationWorkspaces, type ConversationWorkspaces } from './sandboxes/conversation-workspaces.js';
import { createMachineWorkspaces, type KnownMachine } from './sandboxes/machine-workspaces.js';
import { createMachineBackend } from './drivers/machine-backend.js';
import { createToolRuntime } from './tools/tool-runtime.js';
import { createEngineToolHandlers } from './tools/engine-tools.js';
import { TreeTypeDescriptions } from '../services/TreeTypeDescriptions.js';
import { WorkspaceImageService } from '../services/WorkspaceImageService.js';
import { WorkspaceFileService } from '../services/WorkspaceFileService.js';
import type { ComposedWorkspace } from '../lib/workspace-composition.js';
import { WORKSPACE_BASES } from '../extensions/workspace-bases.js';
import { planServerImage, type McpServerRecord, type ServerRuns, type WorkspaceRuns } from '../lib/mcp-servers.js';
import { MCP_SERVER_TEMPLATES } from '../extensions/mcp/templates.js';
import type { TaskStore } from './tools/task-tools.js';
import type { MemoryItem } from './drivers/memory-store.js';
import type { HostNodeServices } from './nodes/services.js';
import { extensionRuntimes, operationHandlers, toolHandlers } from '../extensions/runtime.js';
import { releaseAgentsOf, releaseProblemOf } from '../services/ReleaseSettings.js';
import { restoringApp } from '../lib/release-run.js';
import type { RunTicket, ToolRuntime } from './temporal/contracts.js';
import type { WebTools } from '../lib/web-tools.js';
import type { Database } from '../lib/db-interface.js';
import { createEffortTracker, type EffortTracker, type EffortTrackerOptions } from './registries/effort.js';
import { createCodeRunner } from './nodes/code-runner.js';
import { createWorkspaceServers } from './tools/workspace-servers.js';
import { parkingFor, type Parking, type PublishedWorkspace } from '../lib/published-workspace.js';
import { WORKSPACE_FILE, pendingChanges, type WorkspaceFile } from '../lib/workspace-file.js';
import { groveAgentOf, resolveTreeType } from '../lib/tree-types.js';
import { agentsReachable } from '../extensions/grove/operations/handlers.js';
import { createWorkspaceImages, type WorkspaceImages } from './sandboxes/warm-images.js';
import { createImagePruner, type ImagePruner } from './sandboxes/prune-images.js';
import { createRegistryPackages } from './sandboxes/registry-packages.js';
import { createServerTools } from './tools/server-tools.js';
import { hostedCaller } from './tools/hosted-servers.js';
import { proxyUrlFor } from '../lib/egress-proxy.js';
import { modelNames } from '../lib/model-registry.js';
import type { GroveOperationDeps } from '../extensions/grove/operations/handlers.js';

export interface EngineHostStores {
  actions?: { list(ownerId: string): Promise<import('@koala/harness-types').ActionProposal[]>; save(proposal: import('@koala/harness-types').ActionProposal): Promise<void> } | undefined;
  projectRecords?: (() => Promise<import('../lib/types.js').ProjectMetadata[]>) | undefined;
  machines?: { list(): Promise<readonly KnownMachine[]> } | undefined;
  agentRecords: AgentRecordStore;
  toolGrants: ToolGrantStore;
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
    treeTypeSpecs?: (ownerId: string) => Promise<import('../lib/tree-types.js').TreeTypeSpec[]>;
    workspaceImages?: (ownerId: string) => Promise<import('../lib/workspace-image-seeds.js').WorkspaceImageSpec[]>;
    binding?: (ownerId: string, conversationId: string) => Promise<{ treeId?: string | undefined; projectId?: string | undefined; leafId?: string | undefined; branchId?: string | undefined } | undefined>;
    growing?: import('../extensions/grove/tools/grove-tools.js').TreeGrowing | undefined;
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
  treeModels?: import('../extensions/grove/tools/grove-tools.js').TreeModelChoices | undefined;
  customizations?: Pick<import('../services/CustomizationsService.js').CustomizationsService, 'drift' | 'propose' | 'exportItems'> | undefined;
  monitoring?: import('../extensions/monitoring/handlers.js').MonitoringReading | undefined;
  publishedWorkspaces?: {
    get(ownerId: string, treeId: string): Promise<PublishedWorkspace | undefined>;
    save(workspace: PublishedWorkspace): Promise<void>;
  } | undefined;
  readRepoFile?: ((ownerId: string, repo: string, path: string, ref: string) => Promise<string | undefined>) | undefined;
  writeRepoFile?: ((ownerId: string, repo: string, path: string, content: string, message: string, branch: string) => Promise<{ changed: boolean; commit?: string | undefined }>) | undefined;
  workspaceBuild?: ((ownerId: string, treeId: string, commit: string) => Promise<{ started: true; runId: string } | { started: false; reason: 'running' | 'switched-off' }>) | undefined;
  treeLanguage?: ((ownerId: string, treeId: string) => Promise<string | undefined>) | undefined;
  treeExtras?: ((ownerId: string, treeId: string) => Promise<import('./sandboxes/environments.js').WorkspaceExtras | undefined>) | undefined;
  artifacts?: GroveOperationDeps['artifacts'];
  releases?: import('../extensions/releases/operations/handlers.js').ReleaseOperationDeps | undefined;
  models: ModelServiceLike;
  stores: EngineHostStores;
  web?: WebTools | undefined;
  kubeconfig?: string | undefined;
  registryHost?: string | undefined;
  registryAccount?: (() => Promise<RegistryAccount>) | undefined;
  registryPushToken?: (() => Promise<{ username: string; password: string }>) | undefined;
  onSandbox?: ((driver: EnvironmentDriver, ticket: RunTicket) => Promise<void>) | undefined;
  onLeak?: ((runId: string, ageMs: number) => void) | undefined;
  runEnded?: ((runId: string) => Promise<boolean>) | undefined;
  efforts?: EffortTrackerOptions['store'] | undefined;
  vault?: import('./tools/secret-tools.js').SecretVault | undefined;
  mcpServers?: {
    list(ownerId: string): Promise<McpServerRecord[]>;
    get(ownerId: string, id: string): Promise<McpServerRecord | undefined>;
    save(server: McpServerRecord): Promise<void>;
    hostedUrl(ownerId: string, runs: Extract<ServerRuns, { where: 'hosted' }>): Promise<string | undefined>;
  } | undefined;
  kube?: import('./tools/kube-tools.js').KubeAccess | undefined;
  projects?: import('./tools/project-tools.js').ProjectToolStores | undefined;
  egressSecret?: string | undefined;
  corpus?: import('./tools/corpus-tools.js').CorpusAccess | undefined;
  checks?: import('./tools/check-tools.js').CheckAccess | undefined;
  /** Everyone whose agents could run, so the image sweep asks what each of them wants. */
  owners?: (() => Promise<string[]>) | undefined;
  hidden?: ((ownerId: string) => Promise<import('../lib/extension-settings.js').HiddenVocabulary>) | undefined;
  published?: ((ownerId: string) => Promise<import('@koala/agent-engine/procedure').GroupDefinition[]>) | undefined;
  documents?: DocumentRepos | undefined;
  repoFor?: WorkspaceRepoResolver | undefined;
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
  treeWorkspaceFiles: TreeWorkspaceFiles | undefined;
  machineWork: MachineWork | undefined;
}

export interface TreeWorkspaceFiles {
  files: WorkspaceFileService;
  compose(ownerId: string, treeId: string, file: WorkspaceFile): Promise<ComposedWorkspace>;
}

export function createEngineHost(options: EngineHostOptions): EngineHost {
  const { stores } = options;

  const catalogue = createStoredToolCatalogue({ tools: stores.tools });
  const agents = createAgentDirectory({
    records: stores.agentRecords,
    grants: stores.toolGrants,
    ...(options.hidden ? { hidden: options.hidden } : {}),
  });
  const registry = createStoredAgentRegistry({
    agents,
    procedures: stores.procedures,
    tools: stores.tools,
    ...(options.hidden ? { hidden: options.hidden } : {}),
    ...(options.published ? { published: options.published } : {}),
  });
  const endpoints = createEndpointResolver({ models: options.models, registry });
  const kube = createKubeRunner({ kubeconfig: options.kubeconfig });

  const repoFor = options.repoFor ?? defaultRepoResolver;
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
            ? { onStarted: async () => { await documents.restore({ ownerId: ticket.ownerId, workspaceRunId: workspace.runId, ...(await repoFor(workspace.runId))! }); } }
            : {}),
        }),
      });
      await options.onSandbox?.(driver, ticket);
      return driver;
    },
    ...(options.onLeak ? { onLeak: options.onLeak } : {}),
    ...(options.runEnded ? { ended: options.runEnded } : {}),
  });

  const images = createImageBuilder({
    run: kube,
    ...(options.registryHost ? { registry: options.registryHost } : {}),
    ...(options.registryAccount ? { account: options.registryAccount } : {}),
    ...(options.registryPushToken ? { pushToken: options.registryPushToken } : {}),
  });

  const treeWorkspacesFor: { current?: TreeWorkspaces | undefined } = {};
  const workspaceFiles = options.readRepoFile && options.writeRepoFile ? new WorkspaceFileService({
    trees: () => stores.grove.trees.list(),
    repoOf: (treeId) => repoFor(treeWorkspaceRunId(treeId)),
    read: options.readRepoFile,
    write: options.writeRepoFile,
    branch: LANDING_BASE,
  }) : undefined;
  const published = options.publishedWorkspaces ? {
    get: options.publishedWorkspaces.get,
    save: options.publishedWorkspaces.save,
    file: async (ownerId: string, treeId: string): Promise<string | undefined> => {
      const repo = await repoFor(treeWorkspaceRunId(treeId));
      return repo && options.readRepoFile ? options.readRepoFile(ownerId, repo.repo, WORKSPACE_FILE, LANDING_BASE) : undefined;
    },
    describe: (ownerId: string, treeId: string) => {
      if (!treeWorkspacesFor.current) throw new Error('the tree workspaces are not ready yet');
      return treeWorkspacesFor.current.describe({ treeId, ownerId });
    },
  } : undefined;
  const environments = createEnvironmentResolver({
    registry,
    environments: runEnvironments,
    images,
    tools: (ownerId: string) => catalogue.list(ownerId),
    ...(options.mcpServers ? { servers: options.mcpServers.list } : {}),
    machineBackend: createMachineBackend(),
    ...(stores.machines ? { workspaces: createMachineWorkspaces(stores.machines) } : {}),
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
    ...(published ? { published } : {}),
  });

  const machineWork = documents ? createMachineWork({ documents, repoFor }) : undefined;
  const treeWorkspaces = createTreeWorkspaces({ resolver: environments, kube, documents, repoFor, languageOf: options.treeLanguage, extrasOf: options.treeExtras });
  treeWorkspacesFor.current = treeWorkspaces;
  const conversationWorkspaces = documents
    ? createConversationWorkspaces({ resolver: environments, registry, kube, documents })
    : undefined;

  const web = options.web;
  const treeTypeDescriptions = stores.grove.treeTypeSpecs && stores.grove.workspaceImages
    ? new TreeTypeDescriptions({
      treeTypes: stores.grove.treeTypeSpecs,
      images: stores.grove.workspaceImages,
      releaseAgents: (ownerId) => releaseAgentsOf({
        agents: async (owner: string) => (await registry.agents(owner)).map((agent) => ({ slug: agent.slug, name: agent.name, ...(agent.description ? { description: agent.description } : {}) })),
        procedureOf: async (owner: string, slug: string) => (await registry.runnable(owner, slug))?.procedure,
      }, ownerId),
      restores: restoringApp,
      agentOf: async (ownerId, slug) => {
        const runnable = await registry.runnable(ownerId, slug);
        return runnable && { describe: runnable.agent.description, procedure: runnable.procedure };
      },
    })
    : undefined;
  const workspaceWaits = workspaceFiles && options.publishedWorkspaces
    ? async (ownerId: string, treeId: string): Promise<{ pending: string[]; parking: Parking }> => {
      const onMain = await workspaceFiles.read(ownerId, treeId);
      if (!onMain.ok) return { pending: [], parking: { state: 'coming' } };
      const current = await options.publishedWorkspaces!.get(ownerId, treeId);
      const pending = pendingChanges(current?.file, onMain.file);
      return { pending, parking: parkingFor(current, pending) };
    }
    : undefined;
  const treeAgents = async (ownerId: string, treeId: string): Promise<string[]> => {
    const tree = (await stores.grove.trees.list()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
    const type = tree?.type ? resolveTreeType({ getTreeTypes: async () => (await stores.grove.treeTypeSpecs?.(ownerId)) ?? [] }, ownerId, tree.type) : undefined;
    const runnable = await registry.runnable(ownerId, groveAgentOf(await type));
    return runnable ? agentsReachable(runnable.procedure, async (agent) => (await registry.runnable(ownerId, agent))?.procedure) : [];
  };
  const runtimes = extensionRuntimes({
    releases: {
      ...(options.releases ? { operations: options.releases } : {}),
      ...(stores.actions && stores.projectRecords ? { tools: {
        problem: (ownerId: string, how: unknown) => releaseProblemOf({
          agents: async (owner: string) => (await registry.agents(owner)).map((agent) => ({ slug: agent.slug, name: agent.name, ...(agent.description ? { description: agent.description } : {}) })),
          procedureOf: async (owner: string, slug: string) => (await registry.runnable(owner, slug))?.procedure,
        }, ownerId, how),
        treeTypes: async (ownerId: string) => (await stores.grove.treeTypeSpecs?.(ownerId)) ?? [],
        projects: async (ownerId: string) => (await stores.projectRecords!()).filter((project) => project.ownerId === ownerId),
        proposals: stores.actions,
        ...(options.customizations ? { customizations: options.customizations } : {}),
        projectOfTree: async (ownerId: string, treeId: string) => (await stores.grove.trees.list()).find((entry) => entry.id === treeId && entry.ownerId === ownerId)?.projectIds?.[0],
      } } : {}),
    },
    monitoring: stores.actions ? { tools: { reading: options.monitoring, proposals: stores.actions } } : {},
    platform: { operations: { environments, ...(options.artifacts ? { artifacts: options.artifacts } : {}) } },
    grove: {
      tools: { stores: {
        ...stores.grove,
        ...(treeTypeDescriptions ? { describeTreeType: (ownerId: string, typeId: string) => treeTypeDescriptions.describe(ownerId, typeId), releasingOf: (ownerId: string, typeId: string) => treeTypeDescriptions.releasingOf(ownerId, typeId) } : {}),
        ...(options.treeModels ? { models: options.treeModels } : {}),
        ...(stores.actions ? { actions: stores.actions } : {}),
      } },
      operations: {
        trees: stores.grove.trees,
        branches: stores.grove.branches,
        leaves: stores.grove.leaves,
        tasks: stores.tasks,
        plans: { list: async (ownerId: string) => (await stores.grove.plans?.list(ownerId)) ?? [] },
        treeWorkspaces,
        environments,
        registry,
        ...(stores.grove.treeTypeSpecs ? { treeTypes: stores.grove.treeTypeSpecs } : {}),
        ...(options.artifacts ? { artifacts: options.artifacts } : {}),
        ...(workspaceWaits ? { parking: async (ownerId: string, treeId: string) => (await workspaceWaits(ownerId, treeId)).parking } : {}),
      },
    },
    ...(options.mcpServers ? {
      mcp: { operations: {
        servers: options.mcpServers,
        hostedUrl: options.mcpServers.hostedUrl,
        plan: (runs: WorkspaceRuns, name: string) => planServerImage(runs, name, WORKSPACE_BASES),
        images,
        environments,
      } },
    } : {}),
    ...(published && options.publishedWorkspaces ? {
      workspace: { operations: {
        trees: stores.grove.trees,
        readFile: published.file,
        agentsFor: treeAgents,
        compose: (request) => treeWorkspaces.compose(request),
        images,
        published: options.publishedWorkspaces,
        waiting: {
          branches: stores.grove.branches,
          leaves: stores.grove.leaves,
          tasks: stores.tasks,
          grow: async (ownerId: string, treeId: string) => ({ started: stores.grove.growing ? (await stores.grove.growing.start(ownerId, treeId)).started : false }),
        },
      },
      ...(workspaceFiles && workspaceWaits && options.writeRepoFile && options.workspaceBuild ? { tools: {
        files: workspaceFiles,
        build: options.workspaceBuild,
        tasks: stores.tasks,
        pending: async (ownerId: string, treeId: string) => (await workspaceWaits(ownerId, treeId)).pending,
        ...(stores.grove.binding ? { binding: stores.grove.binding } : {}),
      } } : {}) },
    } : {}),
  });

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
      extensions: toolHandlers(runtimes),
      ...(stores.grove.binding ? { binding: stores.grove.binding } : {}),
      ...(stores.secrets ? { secrets: { stores: stores.secrets, ...(options.vault ? { vault: options.vault } : {}) } } : {}),
      ...(options.mcpServers && stores.mcp ? { mcp: {
        catalogue: options.mcpServers.list,
        stores: stores.mcp,
        ...(options.projects?.proposals ? { proposing: {
          templates: () => MCP_SERVER_TEMPLATES,
          agents: (ownerId: string) => registry.agents(ownerId),
          proposals: options.projects.proposals,
        } } : {}),
      } } : {}),
      ...(options.kube ? { kube: options.kube } : {}),
      ...(options.projects ? { projects: options.projects } : {}),
      ...(stores.egress ? { egress: stores.egress } : {}),
      ...(options.corpus ? { corpus: options.corpus } : {}),
      ...(stores.runs ? { runs: stores.runs } : {}),
      memories: stores.memories,
      ...(options.models.list ? { models: async (ownerId: string) => modelNames(await options.models.list!(ownerId)) } : {}),
      knownTools: async (ownerId: string) => ({
        tools: await catalogue.names(ownerId),
        servers: (options.mcpServers ? await options.mcpServers.list(ownerId) : []).map((server) => ({ name: server.name, tools: (server.captured?.tools ?? []).map((tool) => tool.name) })),
      }),
      ...(options.checks ? { checks: options.checks } : {}),
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
              search: async (query: string, signal?: AbortSignal) => {
                const outcome = await web.search(query, signal);
                return outcome.unavailable
                  ? { error: 'Search is unavailable — no backend could be reached. Rephrasing will not help.' }
                  : { results: outcome.hits };
              },
              fetchPage: (url: string, signal?: AbortSignal) => web.readPage(url, signal),
            },
          }
          : {}),
      },
  });

  const serverTools = options.mcpServers ? createServerTools({
    catalogue: options.mcpServers.list,
    enabled: async (ownerId, conversationId) => (stores.mcp ? stores.mcp.enabled(ownerId, conversationId) : []),
    hosted: { call: hostedCaller(options.mcpServers.hostedUrl) },
    workspace: createWorkspaceServers({ environments: { forRun: (request) => environments.forRun(request) } }),
  }) : undefined;
  const tools = createToolRuntime({ registry, environments, handlers, ...(serverTools ? { serverTools } : {}) });

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
    ...(serverTools ? { serverTools } : {}),
    memories: {
      list: async (ownerId: string) => (await stores.memories.list(ownerId)).filter((memory) => memory.ownerId === ownerId),
      save: stores.memories.save,
    },
    ...(options.hidden ? { hidden: options.hidden } : {}),
    operations: operationHandlers(runtimes),
  };

  const workspaceImages: WorkspaceImages = createWorkspaceImages({
    images,
    personas: (ownerId?: string) => registry.agents(ownerId ?? ''),
    tools: (ownerId?: string) => stores.tools.list(ownerId),
    ...(options.mcpServers ? { servers: options.mcpServers.list } : {}),
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

  const treeWorkspaceFiles = workspaceFiles ? {
    files: workspaceFiles,
    compose: async (ownerId: string, treeId: string, file: WorkspaceFile) => treeWorkspaces.compose({ treeId, ownerId, agents: await treeAgents(ownerId, treeId), file }),
  } : undefined;

  return {
    efforts, workspaceImages, registry, catalogue, endpoints, environments,
    runEnvironments, treeWorkspaces, conversationWorkspaces, images, imagePruner, tools, services, implemented, treeWorkspaceFiles, machineWork,
  };
}

export function storesFromDatabase(db: Database): EngineHostStores {
  return {
    agentRecords: { list: (ownerId: string) => db.getEnginePersonas(ownerId) },
    toolGrants: grantStoreFrom(db),
    procedures: {
      list: (ownerId?: string) => db.getProcedures(ownerId),
      get: (ownerId: string, id: string) => db.getProcedure(ownerId, id),
      save: (source: ProcedureSource) => db.saveProcedure(source),
    },
    tools: { list: (ownerId?: string) => db.getEngineTools(ownerId) },
    conversations: {
      get: (ownerId, id) => db.getConversation(ownerId, id),
      save: (conversation) => db.saveConversation(conversation),
      names: async (ids) => Object.fromEntries((await Promise.all(ids.map(async (id) => [id, (await db.getUserById(id))?.email] as const)))
        .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))),
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
      treeTypeSpecs: (ownerId: string) => db.getTreeTypes(ownerId),
      workspaceImages: (ownerId: string) => new WorkspaceImageService(db).list(ownerId),
      binding: async (ownerId: string, conversationId: string) => {
        const conversation = await db.getConversation(ownerId, conversationId);
        return conversation ? { treeId: conversation.treeId, projectId: conversation.projectId, leafId: conversation.leafId, branchId: conversation.branchId } : undefined;
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
        return conversation ? { treeId: conversation.treeId, projectId: conversation.projectId, leafId: conversation.leafId, branchId: conversation.branchId } : undefined;
      },
    },
    runs: { traces: (ownerId: string, runId: string) => db.getRunTraces(ownerId, runId) },
    actions: { list: (ownerId: string) => db.getActionProposals(ownerId), save: (proposal) => db.saveActionProposal(proposal) },
    projectRecords: () => db.getProjects(),
    machines: { list: () => db.getLocalAgentDevices() },
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
