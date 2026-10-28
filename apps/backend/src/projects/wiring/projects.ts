import type { Server as SocketServer } from 'socket.io';
import { type Database, type SecretKey, type ProjectMetadata, secretNotice, getTemporalClient, roleFromEnv, servesTenants, type Principal } from '../../platform/index.js';
import { groveAgentOf, resolveTreeType, renderStarterFiles, versionVars } from '../lib/tree-types.js';
import { PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from '../lib/project-removal.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { ProjectChannelService } from '../services/ProjectChannelService.js';
import { ItemChatService } from '../services/ItemChatService.js';
import { ConversationNoticeService, type WorkspaceBuildService, type extensionServiceFor } from '../../engine/index.js';
import { projectSecretsFor } from '../services/ProjectSecretsService.js';
import { TreeHomeService } from '../services/TreeHomeService.js';
import { ProjectRemovalService } from '../services/ProjectRemovalService.js';
import { temporalRemovalWorkflows } from '../../accounts/index.js';
import { TreeModelsService, treeAgentsFrom, type ModelService } from '../../models/index.js';
import { GroveRunService } from '../services/GroveRunService.js';
import { GroveDeletionService } from '../services/GroveDeletionService.js';
import { GroveOrderService } from '../services/GroveOrderService.js';
import { TreeWorkspaceService } from '../services/TreeWorkspaceService.js';
import { PlanService } from '../services/PlanService.js';
import { webhookAddress } from '../services/webhook-address.js';
import type { GiteaService } from '../services/GiteaService.js';
import type { InfisicalService, InfrastructureService, ClusterService, AppService, TemporalBridge } from '../../infrastructure/index.js';
import type { MachineService } from '../../machines/index.js';
import type { WorkspaceConclusionService } from '../../memory/index.js';
import type { ProjectSharingService } from '../services/ProjectSharingService.js';
import type { createEngineHost, createRunStarter, createStoredAgentRegistry } from '../../engine-host/index.js';
import { createGroveLauncher } from '../../engine-host/grove-launcher.js';
import { runAskingVia } from '../../engine-host/temporal/run-cancellation.js';
import { DEFAULT_ENGINE_TASK_QUEUE } from '../../engine-host/temporal/contracts.js';
import { notifyGroveChanged } from '../../engine-host/temporal/stream-worker.js';
import { treeWorkspaceRunId, type createWorkspaceRepoResolver } from '../../engine-host/sandboxes/workspace-repos.js';
import { BUILD_WORKSPACE } from '../../extensions/workspace/procedures.js';
import { platformGroups } from '../../extensions/installed.js';
import { projectsRouter } from '../routes/projects.js';
import { projectChannelRouter } from '../routes/project-channel.js';
import { itemChatsRouter } from '../routes/item-chats.js';
import { treesRouter } from '../routes/trees.js';
import { plansRouter } from '../routes/plans.js';
import { branchesRouter } from '../routes/branches.js';
import { leavesRouter } from '../routes/leaves.js';
import type { Mounts } from '../../hub/index.js';

export interface ProjectsCoreDeps {
  db: Database;
  io: SocketServer;
  env: NodeJS.ProcessEnv;
  dataKey: SecretKey;
  gitea: GiteaService;
  infra: InfrastructureService;
  infisical: InfisicalService;
  kubeconfig: string;
}

export interface ProjectsCore {
  projectRepoService: ProjectRepoService;
  channels: ProjectChannelService;
  itemChats: ItemChatService;
  notices: ConversationNoticeService;
  postNotice: (what: string, posting: Promise<unknown>) => void;
  projectSecrets: ReturnType<typeof projectSecretsFor>;
  treeHome: TreeHomeService;
}

export function projectsCore(deps: ProjectsCoreDeps): ProjectsCore {
  const { db, io, gitea } = deps;
  const projectRepoService = new ProjectRepoService(db, gitea, deps.dataKey, webhookAddress(deps.infra, deps.kubeconfig, deps.env.PORT || 3001));
  const channels = new ProjectChannelService({
    conversation: (ownerId, id) => db.engine.getConversation(ownerId, id),
    save: (conversation) => db.engine.saveConversation(conversation),
    bind: (ownerId, conversationId, binding) => db.engine.bindConversation(ownerId, conversationId, binding),
    trees: () => db.projects.getTrees(),
    saveProjectInfo: (project) => db.projects.saveProjectInfo(project),
  });
  const itemChats = new ItemChatService({
    leaves: () => db.projects.getLeaves(),
    branches: () => db.projects.getBranches(),
    trees: () => db.projects.getTrees(),
    conversation: (ownerId, id) => db.engine.getConversation(ownerId, id),
    save: (conversation) => db.engine.saveConversation(conversation),
  });
  const notices = new ConversationNoticeService({
    conversations: () => db.engine.getConversations(),
    append: (ownerId, conversationId, message) => db.engine.appendNotice(ownerId, conversationId, message),
    told: (ownerId, conversationId) => { io.to(`user:${ownerId}`).emit('conversation-notice', { conversationId }); },
    channelOf: async (ownerId, projectId) => {
      const project = (await db.projects.getProjects()).find((entry) => entry.id === projectId && entry.ownerId === ownerId);
      return project ? (await channels.ensure(project))?.id : undefined;
    },
    itemChatOf: async (ownerId, item) => (await itemChats.ensure(ownerId, item))?.id,
  });
  const postNotice = (what: string, posting: Promise<unknown>) => { posting.catch((err: Error) => console.warn(`[notices] ${what}: ${err.message}`)); };
  const projectSecrets = projectSecretsFor({
    db: db.projects,
    backend: deps.infisical,
    readToken: async (ownerId) => (await projectRepoService.mintReadToken(ownerId)).token,
    asked: (request) => { if (request.projectId) postNotice('a secret was asked for', notices.post(request.ownerId, { projectId: request.projectId, treeId: request.treeId }, secretNotice({ ...request, projectId: request.projectId }))); },
  });
  const treeHome = new TreeHomeService({
    treeTypes: (ownerId) => db.projects.getTreeTypes(ownerId),
    projects: () => db.projects.getProjects(),
    createProject: (ownerId, project) => projectRepoService.createProject(ownerId, project),
    starter: async (type, tree) => renderStarterFiles(type.files, { projectName: tree.name, registryHost: await gitea.getRegistryHost(), ...versionVars(type, tree) }),
    saveTree: (tree) => db.projects.saveTree(tree),
    secrets: projectSecrets,
    channel: (project) => channels.ensure(project),
    saveNeeds: (project, needs) => db.projects.saveProjectInfo({ id: project.id, needs }),
  });
  return { projectRepoService, channels, itemChats, notices, postNotice, projectSecrets, treeHome };
}

type EngineHost = Awaited<ReturnType<typeof createEngineHost>>;

export interface ProjectsWiringDeps {
  tenant: Mounts;
  db: Database;
  io: SocketServer;
  env: NodeJS.ProcessEnv;
  dataKey: SecretKey;
  core: ProjectsCore;
  gitea: GiteaService;
  infra: InfrastructureService;
  clusters: ClusterService;
  apps: AppService;
  temporalBridge: TemporalBridge;
  models: ModelService;
  machines: Pick<MachineService, 'list'>;
  registry: ReturnType<typeof createStoredAgentRegistry>;
  runs: ReturnType<typeof createRunStarter>;
  extensions: ReturnType<typeof extensionServiceFor>;
  evalHost: Pick<EngineHost, 'checkNeeds' | 'treeWorkspaceFiles' | 'treeWorkspaces'>;
  workspaceBuilds: Pick<WorkspaceBuildService, 'start'>;
  workspaceConclusions: Pick<WorkspaceConclusionService, 'conclude'>;
  workspaceRepos: ReturnType<typeof createWorkspaceRepoResolver>;
  concluded: (ownerId: string, conversationId: string | undefined) => void;
  sharing: () => Pick<ProjectSharingService, 'shared' | 'takeBackForDeletion'> | undefined;
  getOwnedProject: (id: string, principal: Principal) => Promise<ProjectMetadata | undefined>;
}

export interface ProjectsWiring {
  treeModels: TreeModelsService;
  groveRuns: GroveRunService;
  groveDeletion: GroveDeletionService;
  groveOrder: GroveOrderService;
  planService: PlanService;
}

export function wireProjects(deps: ProjectsWiringDeps): ProjectsWiring {
  const { tenant, db, io, env, core, gitea, temporalBridge, evalHost } = deps;
  const { projectRepoService, channels, itemChats, treeHome } = core;
  const engineQueue = env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE;

  if (servesTenants(roleFromEnv(env))) {
    void gitea.makeUsersPrivate()
      .then((changed) => { if (changed.length) console.log(`[gitea] made ${changed.length} user(s) private: ${changed.join(', ')}`); })
      .catch((err: Error) => console.warn(`[gitea] could not make every Gitea user private at startup: ${err.message}`));
  }

  const projectRemoval = new ProjectRemovalService({
    store: db,
    hub: {
      shared: async (projectId) => (deps.sharing()?.shared(projectId) ?? false),
      takeBack: async (ownerId, projectId) => { await deps.sharing()?.takeBackForDeletion(ownerId, projectId); },
    },
    workflows: temporalRemovalWorkflows<{ projectId: string }, ProjectRemovalStep>(() => temporalBridge.client, engineQueue, PROJECT_REMOVAL_PROGRESS_QUERY),
  });
  tenant.use('/api/projects', projectsRouter({
    db, projectRepoService, appService: deps.apps, temporalBridge, getOwnedProject: deps.getOwnedProject,
    giteaService: gitea, clusterService: deps.clusters, infraService: deps.infra, dataKey: deps.dataKey, removal: projectRemoval, channels,
  }));
  tenant.use('/api/items', itemChatsRouter({ items: itemChats }));
  tenant.use('/api/projects', projectChannelRouter({
    channels,
    conversations: async (ownerId) => (await db.engine.getConversations()).filter((conversation) => conversation.ownerId === ownerId),
    getOwnedProject: deps.getOwnedProject,
  }));

  const treeModels = new TreeModelsService({ store: db.projects, models: deps.models, agentOf: treeAgentsFrom(deps.registry), machines: (ownerId) => deps.machines.list(ownerId), groups: platformGroups });
  const groveRuns = new GroveRunService({
    store: db,
    asking: runAskingVia(() => getTemporalClient()),
    ...(evalHost.checkNeeds ? { checkNeeds: evalHost.checkNeeds } : {}),
    launcher: createGroveLauncher({
      hidden: (ownerId: string) => deps.extensions.hidden(ownerId),
      runs: deps.runs,
      client: () => (temporalBridge.isReady() ? temporalBridge.client.workflow : undefined),
      agentFor: async (ownerId: string, treeId: string) => {
        const tree = (await db.projects.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
        return groveAgentOf(await resolveTreeType(db.projects, ownerId, tree?.type));
      },
      leafRun: async (leafId: string) => (await db.projects.getLeaves()).find((leaf) => leaf.id === leafId)?.runId,
      modelFor: (ownerId, treeId, agentSlug) => treeModels.modelFor(ownerId, treeId, agentSlug),
    }),
  });
  const treeConclusions = { release: (treeId: string, ownerId: string) => deps.workspaceConclusions.conclude(ownerId, { kind: 'tree', id: treeId }) };
  const groveDeletion = new GroveDeletionService({
    store: db,
    workflows: { stop: (workflowId, reason) => temporalBridge.stopIfRunning(workflowId, reason) },
    workspaces: treeConclusions,
  });
  const groveOrder = new GroveOrderService({ store: db.projects });
  const treeWorkspace = evalHost.treeWorkspaceFiles ? new TreeWorkspaceService({
    trees: () => db.projects.getTrees(),
    files: evalHost.treeWorkspaceFiles.files,
    compose: evalHost.treeWorkspaceFiles.compose,
    published: (ownerId, treeId) => db.engine.getPublishedWorkspace(ownerId, treeId),
    builds: (ownerId) => db.engine.getRunEffort(ownerId, BUILD_WORKSPACE.id),
    startBuild: (ownerId, treeId, commit) => deps.workspaceBuilds.start(ownerId, treeId, commit),
  }) : undefined;
  tenant.use('/api/trees', treesRouter({
    db,
    ...(treeWorkspace ? { workspaceFile: treeWorkspace } : {}),
    order: groveOrder,
    home: treeHome,
    workspaces: { state: (treeId) => evalHost.treeWorkspaces.state(treeId), ...treeConclusions },
    runs: groveRuns,
    models: treeModels,
    changed: notifyGroveChanged(io),
    deletion: groveDeletion,
    landings: {
      pullRequests: async (ownerId, treeId) => {
        const repo = await deps.workspaceRepos(treeWorkspaceRunId(treeId));
        const account = await db.projects.getGiteaAccount(ownerId);
        if (!repo || !account) return [];
        return (await gitea.findRepo(account.username, repo.repo)) ? gitea.pullRequests(account.username, repo.repo) : [];
      },
    },
  }));
  const planService = new PlanService({
    store: db.projects,
    adopter: temporalBridge,
    onSettled: deps.concluded,
    stories: async (ownerId) => (await db.projects.getLeaves()).filter((leaf) => leaf.ownerId === ownerId).map((leaf) => ({ id: leaf.id, title: leaf.title, status: leaf.status })),
  });
  tenant.use('/api/plans', plansRouter({ plans: planService }));
  tenant.use('/api/branches', branchesRouter({ db: db.projects, deletion: groveDeletion, order: groveOrder }));
  tenant.use('/api/leaves', leavesRouter({ db: db.projects, runs: groveRuns, deletion: groveDeletion }));
  return { treeModels, groveRuns, groveDeletion, groveOrder, planService };
}
