import http from 'node:http';
import axios, { type AxiosInstance } from 'axios';
import express, { Router } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { createAgentRegistry, createRunStarter, type Task, type WorkflowStarter } from '../../engine-host/index.js';
import { ApprovalService } from '../../engine/services/ApprovalService.js';
import type { ActionService } from '../../engine/services/ActionService.js';
import type { AgentService } from '../../engine/services/AgentService.js';
import type { DocumentService } from '../../engine/services/DocumentService.js';
import type { McpService } from '../../engine/services/McpService.js';
import type { McpServerService } from '../../engine/services/McpServerService.js';
import type { ScriptedModelService } from '../../checks/services/ScriptedModelService.js';
import type { ArtifactService } from '../../files/services/ArtifactService.js';
import type { RepositoryDropService } from '../../files/services/RepositoryDropService.js';
import type { StoryDropService } from '../../files/services/StoryDropService.js';
import type { HubService } from '../../hub/services/HubService.js';
import type { ProjectSharingService } from '../../projects/services/ProjectSharingService.js';
import type { AppService } from '../../infrastructure/services/AppService.js';
import type { AppExposureService } from '../../infrastructure/services/AppExposureService.js';
import type { ClusterService } from '../../infrastructure/services/ClusterService.js';
import type { ClusterAccess } from '../../infrastructure/services/ClusterAccess.js';
import type { TemporalBridge } from '../../infrastructure/services/TemporalBridge.js';
import type { MonitoringService } from '../../monitoring/services/MonitoringService.js';
import type { OdooReleaseService } from '../../releases/services/OdooReleaseService.js';
import type { ReleaseSettings } from '../../releases/services/ReleaseSettings.js';
import type { ClientImportService } from '../../releases/services/ClientImportService.js';
import type { GiteaService } from '../../projects/services/GiteaService.js';
import type { ProjectRepoService } from '../../projects/services/ProjectRepoService.js';
import type { ProjectRemovalService } from '../../projects/services/ProjectRemovalService.js';
import type { GroveRunService } from '../../projects/services/GroveRunService.js';
import type { GroveDeletionService } from '../../projects/services/GroveDeletionService.js';
import type { GroveOrderService } from '../../projects/services/GroveOrderService.js';
import type { TreeHomeService } from '../../projects/services/TreeHomeService.js';
import type { TreeWorkspaceService } from '../../projects/services/TreeWorkspaceService.js';
import type { TreeModelsService } from '../../models/services/TreeModelsService.js';
import type { TreeWorkspaces } from '../../engine-host/sandboxes/tree-workspaces.js';
import { ProjectChannelService } from '../../projects/services/ProjectChannelService.js';
import { ItemChatService } from '../../projects/services/ItemChatService.js';
import { PlanService } from '../../projects/services/PlanService.js';
import { actionsRouter } from '../../engine/routes/actions.js';
import { agentsRouter } from '../../engine/routes/agents.js';
import { conversationsRouter } from '../../engine/routes/conversations.js';
import { documentsRouter } from '../../engine/routes/documents.js';
import { engineRouter } from '../../engine/routes/engine.js';
import { mcpRouter } from '../../engine/routes/mcp.js';
import { turnsRouter } from '../../engine/routes/turns.js';
import { checksRouter } from '../../checks/routes/checks.js';
import { artifactsRouter } from '../../files/routes/artifacts.js';
import { projectFilesRouter } from '../../files/routes/project-files.js';
import { hubRouter } from '../../hub/routes/hub.js';
import { projectSharingRouter } from '../../hub/routes/project-sharing.js';
import { deploymentsRouter } from '../../infrastructure/routes/deployments.js';
import { monitoringRouter } from '../../monitoring/routes/monitoring.js';
import { branchesRouter } from '../../projects/routes/branches.js';
import { itemChatsRouter } from '../../projects/routes/item-chats.js';
import { leavesRouter } from '../../projects/routes/leaves.js';
import { plansRouter } from '../../projects/routes/plans.js';
import { projectChannelRouter } from '../../projects/routes/project-channel.js';
import { projectsRouter } from '../../projects/routes/projects.js';
import { treeTypesRouter } from '../../projects/routes/tree-types.js';
import { treesRouter } from '../../projects/routes/trees.js';
import { releaseSettingsRouter } from '../../releases/routes/release-settings.js';
import { releasesRouter } from '../../releases/routes/releases.js';
import { clientImportRouter } from '../../releases/routes/client-import.js';
import { authRouter } from '../../accounts/routes/auth.js';
import { AuthService } from '../../accounts/services/AuthService.js';
import { createAuth } from '../../platform/middleware/auth.js';
import { SessionEnds } from '../../platform/services/SessionEnds.js';
import { errorResponder } from '../../platform/middleware/async-route.js';
import { authorize, type Principal } from '../../platform/lib/permissions.js';
import { sessionToken } from '../../platform/lib/auth.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { PlanAdopter } from '../../projects/services/PlanService.js';

export const SESSION_KEY = 'check-api-session-key';

export interface CheckApiPorts {
  workflows: { started: { type: string; runId: string; conversationId: string | undefined; owner: string }[]; signals: { workflowId: string; name: string; payload: unknown }[]; onStart: (started: { runId: string; conversationId: string | undefined; owner: string }) => Promise<void> };
  actions: MockProxy<ActionService>;
  agents: MockProxy<AgentService>;
  documents: MockProxy<DocumentService>;
  mcp: MockProxy<McpService>;
  catalogue: MockProxy<McpServerService>;
  scripted: MockProxy<ScriptedModelService>;
  artifacts: MockProxy<ArtifactService>;
  repositoryDrops: MockProxy<RepositoryDropService>;
  storyDrops: MockProxy<StoryDropService>;
  hub: MockProxy<HubService>;
  sharing: MockProxy<ProjectSharingService>;
  appService: MockProxy<AppService>;
  exposure: MockProxy<AppExposureService>;
  clusters: MockProxy<ClusterService>;
  access: MockProxy<ClusterAccess>;
  bridge: MockProxy<TemporalBridge>;
  monitoring: MockProxy<MonitoringService>;
  releases: MockProxy<OdooReleaseService>;
  releaseSettings: MockProxy<ReleaseSettings>;
  imports: MockProxy<ClientImportService>;
  gitea: MockProxy<GiteaService>;
  repos: MockProxy<ProjectRepoService>;
  removal: MockProxy<ProjectRemovalService>;
  groveRuns: MockProxy<GroveRunService>;
  groveDeletion: MockProxy<GroveDeletionService>;
  groveOrder: MockProxy<GroveOrderService>;
  treeHome: MockProxy<TreeHomeService>;
  treeWorkspaceFile: MockProxy<TreeWorkspaceService>;
  treeModels: MockProxy<TreeModelsService>;
  treeWorkspaces: MockProxy<TreeWorkspaces>;
  adopter: MockProxy<PlanAdopter>;
  workspaceState: { conversation: 'none' | 'running' | 'parked' };
  pullRequests: { number: number; title: string; head: string; base: string; state: string; merged: boolean }[];
}

export interface CheckApi {
  db: MongoDB;
  ports: CheckApiPorts;
  baseURL: string;
  cookieFor: (user: { id: string; email: string }) => string;
  clientFor: (user: { id: string; email: string }) => AxiosInstance;
  close: () => Promise<void>;
}

const noWorkflows = (): CheckApiPorts['workflows'] => ({ started: [], signals: [], onStart: async () => undefined });

export async function mountCheckApi(): Promise<CheckApi> {
  axios.defaults.proxy = false;
  const db = await testDatabase();
  const workflows = noWorkflows();
  const starter: WorkflowStarter = {
    async start(type, options) {
      const input = options.args[0] as { ticket: { runId: string; conversationId?: string } };
      const started = { runId: input.ticket.runId, conversationId: input.ticket.conversationId, owner: options.owner };
      workflows.started.push({ type, ...started });
      await workflows.onStart(started);
      return { workflowId: options.workflowId };
    },
    async signal(workflowId, name, payload) {
      workflows.signals.push({ workflowId, name, payload });
    },
  };
  const registry = createAgentRegistry();
  const runs = createRunStarter({ registry, workflows: () => starter });

  const ports: CheckApiPorts = {
    workflows,
    actions: mock<ActionService>(),
    agents: mock<AgentService>(),
    documents: mock<DocumentService>(),
    mcp: mock<McpService>(),
    catalogue: mock<McpServerService>(),
    scripted: mock<ScriptedModelService>(),
    artifacts: mock<ArtifactService>(),
    repositoryDrops: mock<RepositoryDropService>(),
    storyDrops: mock<StoryDropService>(),
    hub: mock<HubService>(),
    sharing: mock<ProjectSharingService>(),
    appService: mock<AppService>(),
    exposure: mock<AppExposureService>(),
    clusters: mock<ClusterService>(),
    access: mock<ClusterAccess>(),
    bridge: mock<TemporalBridge>(),
    monitoring: mock<MonitoringService>(),
    releases: mock<OdooReleaseService>(),
    releaseSettings: mock<ReleaseSettings>(),
    imports: mock<ClientImportService>(),
    gitea: mock<GiteaService>(),
    repos: mock<ProjectRepoService>(),
    removal: mock<ProjectRemovalService>(),
    groveRuns: mock<GroveRunService>(),
    groveDeletion: mock<GroveDeletionService>(),
    groveOrder: mock<GroveOrderService>(),
    treeHome: mock<TreeHomeService>(),
    treeWorkspaceFile: mock<TreeWorkspaceService>(),
    treeModels: mock<TreeModelsService>(),
    treeWorkspaces: mock<TreeWorkspaces>(),
    adopter: mock<PlanAdopter>(),
    workspaceState: { conversation: 'none' },
    pullRequests: [],
  };

  const auth = createAuth({ db, sessionKey: SESSION_KEY as never, publicUrl: 'http://localhost:3001', sessionEnds: new SessionEnds(db.platform) });
  const authService = new AuthService(db, {});
  const getOwnedProject = async (id: string, principal: Principal) => {
    const project = (await db.projects.getProjects()).find((candidate) => candidate.id === id);
    return project && authorize(principal, 'see', { kind: 'project', ownerId: project.ownerId }).allowed ? project : undefined;
  };
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
  const plans = new PlanService({ store: db.projects, adopter: ports.adopter });
  const tasks = {
    list: (ownerId: string) => db.projects.getTasks(ownerId),
    save: (task: Task) => db.projects.saveTask(task),
  };

  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', auth.requireAuth);
  app.use('/api/auth', authRouter({
    db, authService, auth, sessionKey: SESSION_KEY as never, appUrl: 'http://localhost:5173',
    passwords: { newPasswordProblem: () => undefined },
  }));
  app.use('/api/engine', engineRouter({
    runs,
    registry,
    approvals: new ApprovalService({ store: db.engine, runs }),
    tasks,
    traces: { list: (ownerId, runId) => db.engine.getRunTraces(ownerId, runId) },
    endings: { list: (ownerId, runIds) => db.engine.getRunEndings(ownerId, runIds) },
  }));
  app.use('/api/turns', turnsRouter({ log: { read: (ownerId, turnId, after) => db.engine.getTurnLog(ownerId, turnId, after), recent: (ownerId, since, limit) => db.engine.recentTurns(ownerId, since, limit) } }));
  app.use('/api/conversations', conversationsRouter({
    db,
    ownedConversations: async (userId) => (await db.engine.getConversations()).filter((conversation) => conversation.ownerId === userId),
    ownedTrees: async (userId) => (await db.projects.getTrees()).filter((tree) => tree.ownerId === userId),
    ownedProjects: async (userId) => (await db.projects.getProjects()).filter((project) => project.ownerId === userId),
    workspaces: { conclude: async () => undefined, state: async () => ports.workspaceState.conversation },
  }));
  app.use('/api/agents', agentsRouter({ agents: ports.agents }));
  app.use('/api/mcp', mcpRouter({ mcp: ports.mcp, catalogue: ports.catalogue }));
  app.use('/api/documents', documentsRouter({ documents: ports.documents }));
  app.use('/api/artifacts', artifactsRouter({ artifacts: ports.artifacts }));
  app.use('/api/checks', checksRouter({ scripted: ports.scripted }));
  app.use('/api/actions', actionsRouter({ actions: ports.actions }));
  app.use('/api/plans', plansRouter({ plans }));
  app.use('/api/leaves', leavesRouter({ db: db.projects, runs: ports.groveRuns, deletion: ports.groveDeletion }));
  app.use('/api/branches', branchesRouter({ db: db.projects, deletion: ports.groveDeletion, order: ports.groveOrder }));
  app.use('/api/items', itemChatsRouter({ items: itemChats }));
  app.use('/api/trees', treesRouter({
    db,
    workspaces: ports.treeWorkspaces,
    runs: ports.groveRuns,
    deletion: ports.groveDeletion,
    order: ports.groveOrder,
    home: ports.treeHome,
    landings: { pullRequests: async () => ports.pullRequests },
    workspaceFile: ports.treeWorkspaceFile,
    models: ports.treeModels,
  }));
  app.use('/api/tree-types', treeTypesRouter({ db, agents: async () => [], ownNamespaces: async () => new Set<string>() }));
  const projects = Router();
  projects.use(projectChannelRouter({ channels, conversations: async (ownerId) => (await db.engine.getConversations()).filter((conversation) => conversation.ownerId === ownerId), getOwnedProject }));
  projects.use(releasesRouter({ releases: ports.releases, getOwnedProject, signIns: async () => [] }));
  projects.use(projectFilesRouter({ projectRepoService: ports.repos, giteaService: ports.gitea, getOwnedProject, drops: ports.repositoryDrops, storyDrops: ports.storyDrops }));
  projects.use(clientImportRouter({ imports: ports.imports, getOwnedProject }));
  projects.use(projectsRouter({ db, getOwnedProject, projectRepoService: ports.repos, temporalBridge: ports.bridge, giteaService: ports.gitea, clusterService: ports.clusters, channels, removal: ports.removal }));
  app.use('/api/projects', projects);
  app.use('/api/release-settings', releaseSettingsRouter({ settings: ports.releaseSettings }));
  app.use('/api/deployments', deploymentsRouter({ appService: ports.appService, clusterService: ports.clusters, appExposureService: ports.exposure, access: ports.access, temporalBridge: ports.bridge, db, io: mock<SocketServer>() }));
  app.use('/api/monitoring', monitoringRouter({ monitoring: ports.monitoring }));
  app.use('/api/project-sharing', projectSharingRouter({ sharing: ports.sharing }));
  app.use('/api/hub', hubRouter({ hub: ports.hub }));
  app.use(errorResponder);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const baseURL = `http://127.0.0.1:${port}/api`;
  const cookieFor = (user: { id: string; email: string }) => `session=${sessionToken(user, SESSION_KEY as never)}`;

  return {
    db,
    ports,
    baseURL,
    cookieFor,
    clientFor: (user) => axios.create({ baseURL, proxy: false, headers: { Cookie: cookieFor(user) } }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
