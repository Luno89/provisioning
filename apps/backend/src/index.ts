import { WorkflowNotFoundError } from '@temporalio/client';
import { PROCEDURE_CHANGE_AGENT } from './lib/agent-usage.js';
import { getModelRateLimiterSnapshot, type PersonaRecord } from '@koala/agent-engine';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const LOG_TAIL_LINES = 200;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { Server as SocketServer } from 'socket.io';

import { credentialsRouter } from './routes/credentials.js';
import { llmCredentialsRouter } from './routes/llm-credentials.js';
import { backupRouter } from './routes/backup.js';
import { clustersRouter } from './routes/clusters.js';
import { deploymentsRouter } from './routes/deployments.js';
import { treeTypesRouter } from './routes/tree-types.js';
import { bindingTypesRouter } from './routes/binding-types.js';
import { treesRouter } from './routes/trees.js';
import { plansRouter } from './routes/plans.js';
import { secretRequestsRouter } from './routes/secret-requests.js';
import { mcpRouter } from './routes/mcp.js';
import { actionsRouter } from './routes/actions.js';
import { egressRouter } from './routes/egress.js';
import { clusterAccessRouter } from './routes/cluster-access.js';
import { AccessService } from './services/AccessService.js';
import { EgressService } from './services/EgressService.js';
import { EgressProxyService } from './services/EgressProxyService.js';
import { ActionService } from './services/ActionService.js';
import { GroveOrderService } from './services/GroveOrderService.js';
import { AutoModeService } from './services/AutoModeService.js';
import { McpService } from './services/McpService.js';
import { SecretRequestService } from './services/SecretRequestService.js';
import { PlanService } from './services/PlanService.js';
import { GroveRunService } from './services/GroveRunService.js';
import { GroveDeletionService } from './services/GroveDeletionService.js';
import { branchesRouter } from './routes/branches.js';
import { leavesRouter } from './routes/leaves.js';
import { memoriesRouter } from './routes/memories.js';
import { authRouter } from './routes/auth.js';
import { conversationsRouter } from './routes/conversations.js';
import helmet from 'helmet';
import { MetricsService } from './services/MetricsService.js';
import { rateLimit } from 'express-rate-limit';
import { RATE_LIMITS, ruleFor } from './lib/http-limits.js';
import { engineRouter } from './routes/engine.js';
import { wireReleases } from './wiring/releases.js';
import { storyDropsFor, wireFiles } from './wiring/files.js';
import { wireMachines } from './wiring/machines.js';
import { wireMonitoring } from './wiring/monitoring.js';
import { hubInstanceWork, wireHub } from './wiring/hub.js';
import { proceduresRouter } from './routes/procedures.js';
import { ProcedureService } from './services/ProcedureService.js';
import { createProcedureStore, stepNeedsReader } from './engine-host/registries/procedure-store.js';
import { createModelNodes, hostNodesFor } from './engine-host/nodes/index.js';
import { agentsRouter } from './routes/agents.js';
import { autoModeRouter } from './routes/auto-mode.js';
import { engineToolsRouter } from './routes/engine-tools.js';
import { EngineToolService } from './services/EngineToolService.js';
import { AgentService } from './services/AgentService.js';
import { evalsLevel2Router } from './routes/evals-level2.js';
import { buildWebTools } from './wiring/web-tools.js';
import { Level2Service, temporalCheckRunner } from './services/Level2Service.js';
import { createStoredToolCatalogue, createEngineHost, storesFromDatabase, createStoredAgentRegistry, directoryFromDatabase, createEndpointResolver, createRunStarter, startStreamWorker } from './engine-host/index.js';
import { notifyGroveChanged, userRoom } from './engine-host/temporal/stream-worker.js';
import { createWorkspaceRepoResolver, treeWorkspaceRunId } from './engine-host/sandboxes/workspace-repos.js';
import { PRUNE_FIRST_DELAY_MS, PRUNE_INTERVAL_MS } from './engine-host/sandboxes/prune-images.js';
import { labelValue } from './engine-host/sandboxes/workspace.js';
import { conversationBinding } from './engine-host/conversation-binding.js';
import { runAskingVia, runCancelledVia, runWaitingVia } from './engine-host/temporal/run-cancellation.js';
import { getTemporalClient, resolveOwnersWith } from './lib/temporal-client.js';
import { PayloadStorageService } from './services/PayloadStorageService.js';
import { MemoryKeeperService } from './services/MemoryKeeperService.js';
import { BENCH_IDLE_WORKFLOW, CONVERSATION_CONCLUSION_WORKFLOW, DEFAULT_ENGINE_TASK_QUEUE, benchIdleId, conversationConclusionId, treeOfGroveRun, workflowOfRun } from './engine-host/temporal/contracts.js';
import { BenchService } from './services/BenchService.js';
import { PracticeService } from './services/PracticeService.js';
import { scenarioSubjects } from './lib/check-subjects.js';
import { randomUUID } from 'node:crypto';
import { AgentChangeService } from './services/AgentChangeService.js';
import { fingerprintOf } from './lib/bench.js';
import { createAuth } from './middleware/auth.js';
import { projectsRouter } from './routes/projects.js';
import { pendingApprovalsRouter } from './routes/pending-approvals.js';
import { startedFor } from './lib/workflow-owner.js';
import { poolSettingsFrom } from './lib/pool.js';
import { keepTrying } from './lib/keep-trying.js';
import { mongoTarget } from './lib/mongo-db.js';
import { MoveExport } from './services/MoveExport.js';
import { moveRouter } from './routes/move.js';
import { MoveRelay, kubeconfigFile } from './services/MoveRelay.js';
import { issueMoveToken } from './lib/identity-token.js';
import { MOVE_FINISHED, MOVE_STOPPED, answersWhileMoving, poolMoveWorkflowId } from './lib/instance-move.js';
import { PoolMonitoringService } from './services/PoolMonitoringService.js';
import { poolRemoveWorkflowId, poolTrialWorkflowId, TRIAL_CHANGED } from './lib/pool-trial.js';
import { askDevice, findDeviceByToken, localAgentStatus, registerDevice, tellDevice, unregisterDevice } from './lib/local-agent-registry.js';
import { MachineService } from './services/MachineService.js';
import { RootMeshKeys } from './services/RootMeshKeys.js';
import { asyncRoute } from './middleware/async-route.js';
import { clusterProvidersRouter } from './routes/cluster-providers.js';
import { vpsCatalogRouter } from './routes/vps-catalog.js';
import { adminRouter } from './routes/admin.js';
import { modelsRouter } from './routes/models.js';
import { temporalRouter } from './routes/temporal.js';
import { workerRouter } from './routes/worker.js';
import { nginxRouter } from './routes/nginx.js';
import { logsRouter } from './routes/logs.js';
import { registryRouter } from './routes/registry.js';
import { modulesRouter } from './routes/modules.js';
import { appSchemasRouter } from './routes/app-schemas.js';
import { ownsProject, ownedBy } from './lib/ownership.js';
import { createDatabase, sharedPayloadBlobs, type Database } from './lib/db-interface.js';
import { migrateLegacyOwnership } from './lib/migrate-ownership.js';

import { InfrastructureService } from './services/InfrastructureService.js';
import { ClusterService } from './services/ClusterService.js';
import { AppService } from './services/AppService.js';
import { RegistryService } from './services/RegistryService.js';
import { GitModuleService } from './services/GitModuleService.js';
import { BuilderService } from './services/BuilderService.js';
import { AppExposureService } from './services/AppExposureService.js';
import type { UserMetadata } from './lib/types.js';
import { VpsCatalogService } from './services/VpsCatalogService.js';
import { TemporalBridge } from './services/TemporalBridge.js';
import WorkerService from './services/WorkerService.js';
import { sharedClusterProxy } from './services/ClusterProxyService.js';
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import axios from 'axios';
import { httpCheckAccess } from './services/CheckToolAccess.js';
import { ApprovalService } from './services/ApprovalService.js';
import { AuthService } from './services/AuthService.js';
import { CredentialService } from './services/CredentialService.js';
import { GiteaService } from './services/GiteaService.js';
import { InfisicalService } from './services/InfisicalService.js';
import { ProjectRepoService } from './services/ProjectRepoService.js';
import { WorkspaceConclusionService } from './services/WorkspaceConclusionService.js';
import { ConversationTurnService } from './services/ConversationTurnService.js';
import { turnsRouter } from './routes/turns.js';
import { DocumentService } from './services/DocumentService.js';
import { documentsRouter } from './routes/documents.js';
import { HeadscaleService } from './services/HeadscaleService.js';
import { ModelService } from './services/ModelService.js';
import { decryptValue } from './lib/crypto.js';

import { McpServerService } from './services/McpServerService.js';
import { hostedMcpUrl } from './lib/mcp-hosted-url.js';
import { MCP_SERVER_TEMPLATES } from './extensions/mcp/templates.js';
import { resolveMcpProbeUrl } from './lib/mcp-probe-url.js';
import { resolveWebTools } from './lib/web-tools-resolver.js';
import { seedAll } from './scripts/seed-all.js';
import type { SearchOutcome } from './lib/web-tools.js';
import { createGroveLauncher } from './engine-host/grove-launcher.js';
import { groveAgentOf, resolveTreeType, treeTypeChoices, treeLanguageFrom, treeExtrasFrom, dependencyNamespaceFrom, renderStarterFiles, versionVars } from './lib/tree-types.js';
import { RunningService } from './services/RunningService.js';
import { ownedQuery, ownerIn } from './lib/workflow-owner.js';
import { DEFAULT_BENCH_SETTINGS } from './lib/bench.js';
import { runningRouter } from './routes/running.js';
import { infrastructureRouter } from './routes/infrastructure.js';
import { InfrastructureViewService } from './services/InfrastructureViewService.js';
import { ClusterContentsService } from './services/ClusterContentsService.js';
import { WorkFailureService, type ClosedWorkflow } from './services/WorkFailureService.js';
import type { RunningRecords, RunningWorkflow } from './lib/running.js';
import { TreeHomeService } from './services/TreeHomeService.js';
import { TreeModelsService, treeAgentsFrom } from './services/TreeModelsService.js';
import { restoringApp } from './lib/release-run.js';
import { platformGroups } from './extensions/installed.js';
import { projectSecretsFor } from './services/ProjectSecretsService.js';
import { ConversationNoticeService } from './services/ConversationNoticeService.js';
import { WorkspaceBuildService } from './services/WorkspaceBuildService.js';
import { TreeWorkspaceService } from './services/TreeWorkspaceService.js';
import { BUILD_WORKSPACE } from './extensions/workspace/procedures.js';
import { ProjectChannelService } from './services/ProjectChannelService.js';
import { projectChannelRouter } from './routes/project-channel.js';
import { itemChatsRouter } from './routes/item-chats.js';
import { ItemChatService } from './services/ItemChatService.js';
import { grovedTree, secretNotice, treeNotices, postedNotice } from './lib/notices.js';
import { TreeTypeDescriptions } from './services/TreeTypeDescriptions.js';
import { WorkspaceImageService } from './services/WorkspaceImageService.js';
import { webhookAddress } from './services/webhook-address.js';
import { endpointRulesFromEnv } from './lib/endpoint-url-safety.js';
import { AccountRemovalService, temporalRemovalWorkflows } from './services/AccountRemovalService.js';
import { ROOT_REMOVAL_STEPS, ROOT_REMOVAL_WORKFLOW } from './lib/account-removal.js';
import { ProjectRemovalService } from './services/ProjectRemovalService.js';
import { PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from './lib/project-removal.js';
import { accountRouter } from './routes/account.js';
import { checksRouter } from './routes/checks.js';
import { ScriptedModelService } from './services/ScriptedModelService.js';
import { extensionServiceFor } from './services/ExtensionService.js';
import { loadKeys } from './lib/keys.js';
import { signJWT } from './lib/auth.js';
import { roleFromEnv, servesTenants, holdsAccounts, signsInThroughRoot } from './lib/platform-role.js';
import { HUB_AUDIENCE, hubInstancePart } from './lib/hub.js';
import { machinePayloads, type GetAnswer, type PutAnswer, type RingAnswer } from './lib/machine-payloads.js';
import { IdentityService } from './services/IdentityService.js';
import { identityRouter } from './routes/identity.js';
import { handoffRouter } from './routes/handoff.js';
import { InstanceService } from './services/InstanceService.js';
import { InstanceRoutes, dockerCaddy } from './services/InstanceRoutes.js';
import { InstanceAddresses, adminEdge } from './services/InstanceAddresses.js';
import { instanceTrialRouter } from './routes/instance-trial.js';
import { InstanceTrial } from './services/InstanceTrial.js';
import { instanceAddressesRouter } from './routes/instance-addresses.js';
import { MailService } from './services/MailService.js';
import { NotificationService } from './services/NotificationService.js';
import { emailWayFrom } from './lib/email-way.js';
import { InstanceChart } from './services/InstanceChart.js';
import { instancesRouter } from './routes/instances.js';
import { artifactsRouter } from './routes/artifacts.js';
import { providerServing } from './lib/model-registry.js';
import { WorkspaceDependencyService } from './services/WorkspaceDependencyService.js';
import { workspaceDependenciesRouter } from './routes/workspace-dependencies.js';
import { accountDefaultOf } from './lib/machine-runs.js';
import { createArtifactService } from './services/artifact-service-factory.js';

dotenv.config();

function startHostTunnel(port = 8000) {
  const server = net.createServer((socket) => {
    const child = spawn('docker', ['exec', '-i', 'provisioner-nginx', 'nc', '127.0.0.1', '80']);

    socket.pipe(child.stdin);
    child.stdout.pipe(socket);

    socket.on('error', () => child.kill());
    child.on('error', () => socket.destroy());
    socket.on('close', () => child.kill());
    child.on('close', () => socket.destroy());
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`ℹ️  Host tunnel port ${port} is already bound — reusing existing tunnel.`);
      return;
    }
    console.error(`Host tunnel server error: ${err.message}`);
  });

  server.listen(port, '::', () => {
    console.log(`🚀 Host Tunnel Server active on http://[::]:${port}`);
  });
}

const DEFAULT_LOG_LEVEL = 50;

export async function bootstrap(): Promise<{ app: express.Application; io: SocketServer; temporalBridge?: TemporalBridge; db: Database }> {
  const app = express();
  const httpServer = createServer(app);
  httpServer.requestTimeout = 0;
  const port = process.env.PORT || 3001;

  const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');

  const APP_URL = (process.env.APP_URL || process.env.PUBLIC_URL || 'http://localhost:5173').replace(/\/$/, '');

  const corsAllowed = new Set([PUBLIC_URL, APP_URL]);
  const originAllowed = (origin: string | undefined): boolean =>
    !origin || process.env.NODE_ENV !== 'production' || corsAllowed.has(origin.replace(/\/$/, ''));

  const io = new SocketServer(httpServer, {
    cors: {
      origin: (origin, cb) => cb(null, originAllowed(origin)),
      credentials: true,
    },
  });

  const db = createDatabase();
  await db.init();
  resolveOwnersWith(async (owner) => (await db.getUserById(owner))?.space?.person ?? owner);
  await migrateLegacyOwnership(db);
  await seedAll(db as never);

  const keys = loadKeys(process.env);
  const role = roleFromEnv(process.env);
  const metrics = new MetricsService({ token: process.env.METRICS_TOKEN?.trim() || undefined, role: role.role });
  const mail = new MailService({
    way: emailWayFrom(process.env, role),
    emailOf: async (ownerId) => (await db.getUserById(ownerId))?.email,
  });
  const notifications = new NotificationService({ store: db, mail, publicUrl: PUBLIC_URL, log: (message) => console.warn(message) });
  const tenant: express.Router = servesTenants(role) ? (app as unknown as express.Router) : express.Router();
  const identity = new IdentityService(role, db);
  console.log(`🧭 Running as ${role.role}${role.instance ? ` (instance ${role.instance.id}, owned by ${role.instance.ownerId})` : ''}`);
  const infraService = new InfrastructureService();
  const builderService = new BuilderService(db, infraService);
  const clusterService = new ClusterService(db, infraService, keys.data);
  const artifactStore = createArtifactService(db, infraService, clusterService);
  const appService = new AppService(db, infraService, clusterService, builderService);
  const registryService = new RegistryService(db);
  const gitModuleService = new GitModuleService(db);
  let instanceAddresses: InstanceAddresses | undefined;
  const edgeName = process.env.INSTANCE_NAME;
  const edge = role.instance && edgeName && process.env.EDGE_ADMIN_URL && process.env.EDGE_CADDYFILE
    ? adminEdge(edgeName, process.env.EDGE_ADMIN_URL, process.env.EDGE_CADDYFILE, () => instanceAddresses)
    : undefined;
  const appExposureService = new AppExposureService(db, infraService, clusterService, io, edge);
  if (edge && role.instance) {
    instanceAddresses = new InstanceAddresses(
      { rootUrl: role.instance.rootUrl, instanceId: role.instance.id, credential: process.env.INSTANCE_CREDENTIAL ?? '', name: edge.name },
      () => appExposureService.syncExposedApps(),
    );
    instanceAddresses.refresh().catch((err: Error) => console.warn(`[addresses] ${err.message}`));
  }
  const clusterProxyService = sharedClusterProxy();
  const giteaService = new GiteaService(infraService, keys.data, '/tmp/kubeconfig-provisioning-lunorica');
  await giteaService.ensureClusterSecret().catch((err: Error) =>
    console.warn(`[gitea] could not ensure cluster secret: ${err.message}`),
  );
  const infisicalService = new InfisicalService(
    infraService,
    keys.data,
    '/tmp/kubeconfig-provisioning-lunorica',
    undefined,
    clusterProxyService,
  );
  const projectRepoService = new ProjectRepoService(db, giteaService, keys.data, webhookAddress(infraService, '/tmp/kubeconfig-provisioning-lunorica', process.env.PORT || 3001));
  const channels = new ProjectChannelService({
    conversation: (ownerId, id) => db.getConversation(ownerId, id),
    save: (conversation) => db.saveConversation(conversation),
    bind: (ownerId, conversationId, binding) => db.bindConversation(ownerId, conversationId, binding),
    trees: () => db.getTrees(),
    saveProjectInfo: (project) => db.saveProjectInfo(project),
  });
  const itemChats = new ItemChatService({
    leaves: () => db.getLeaves(),
    branches: () => db.getBranches(),
    trees: () => db.getTrees(),
    conversation: (ownerId, id) => db.getConversation(ownerId, id),
    save: (conversation) => db.saveConversation(conversation),
  });
  const notices = new ConversationNoticeService({
    conversations: () => db.getConversations(),
    append: (ownerId, conversationId, message) => db.appendNotice(ownerId, conversationId, message),
    told: (ownerId, conversationId) => { io.to(`user:${ownerId}`).emit('conversation-notice', { conversationId }); },
    channelOf: async (ownerId, projectId) => {
      const project = (await db.getProjects()).find((entry) => entry.id === projectId && entry.ownerId === ownerId);
      return project ? (await channels.ensure(project))?.id : undefined;
    },
    itemChatOf: async (ownerId, item) => (await itemChats.ensure(ownerId, item))?.id,
  });
  const treeOfProject = async (projectId: string) => (await db.getTrees()).find((tree) => tree.projectIds?.[0] === projectId);
  const postNotice = (what: string, posting: Promise<unknown>) => { posting.catch((err: Error) => console.warn(`[notices] ${what}: ${err.message}`)); };
  const projectSecrets = projectSecretsFor({
    db,
    backend: infisicalService,
    readToken: async (ownerId) => (await projectRepoService.mintReadToken(ownerId)).token,
    asked: (request) => { if (request.projectId) postNotice('a secret was asked for', notices.post(request.ownerId, { projectId: request.projectId, treeId: request.treeId }, secretNotice({ ...request, projectId: request.projectId }))); },
  });
  const treeHome = new TreeHomeService({
    treeTypes: (ownerId) => db.getTreeTypes(ownerId),
    projects: () => db.getProjects(),
    createProject: (ownerId, project) => projectRepoService.createProject(ownerId, project),
    starter: async (type, tree) => renderStarterFiles(type.files, { projectName: tree.name, registryHost: await giteaService.getRegistryHost(), ...versionVars(type, tree) }),
    saveTree: (tree) => db.saveTree(tree),
    secrets: projectSecrets,
    channel: (project) => channels.ensure(project),
    saveNeeds: (project, needs) => db.saveProjectInfo({ id: project.id, needs }),
  });
  const headscaleService = new HeadscaleService(keys.data, process.env.HEADSCALE_URL || 'http://localhost:8080');
  const machineService = new MachineService({
    store: db,
    dataKey: keys.data,
    settings: {
      url: PUBLIC_URL,
      temporalAddress: process.env.MACHINE_TEMPORAL_ADDRESS || (process.env.TEMPORAL_CONNECTION_ADDRESS || 'localhost:7233').replace(/^https?:\/\//, ''),
      temporalNamespace: process.env.TEMPORAL_NAMESPACE || 'default',
      meshLoginServer: process.env.MESH_LOGIN_SERVER,
    },
    devices: { status: localAgentStatus, tell: tellDevice, ask: askDevice },
    projects: projectRepoService,
    mesh: role.instance
      ? new RootMeshKeys({ rootUrl: role.instance.rootUrl, instanceId: role.instance.id, credential: process.env.INSTANCE_CREDENTIAL ?? '' })
      : headscaleService,
  });
  const modelService = new ModelService(db, appService, clusterService, clusterProxyService, headscaleService, keys.data, endpointRulesFromEnv(process.env));


  clusterService.ensureSystemClusterGpuReady().catch((err: any) =>
    console.warn(`[bootstrap] System cluster GPU readiness check failed: ${err.message}`)
  );

  const temporalBridge = new TemporalBridge(db, io, keys.data, clusterService, headscaleService);
  clusterService.setTemporalBridge(temporalBridge);
  appService.setTemporalBridge(temporalBridge);
  if (servesTenants(role)) {
    await keepTrying('⚠️ Temporal TS bridge not available yet, routes fall back to the local DB until it is', async () => {
      await temporalBridge.start();
      await temporalBridge.startActiveWorkflowRecovery();
    }, (message) => console.warn(message));
  }

  const extensions = extensionServiceFor(db);
  const dependencyFollowers: { tools?: EngineToolService; servers?: McpServerService } = {};
  const workspaceDependencies = new WorkspaceDependencyService({
    store: db,
    tools: (ownerId) => db.getEngineTools(ownerId),
    servers: (ownerId) => db.getMcpServers(ownerId),
    workspaces: async (ownerId) => {
      const [published, trees] = await Promise.all([db.getPublishedWorkspaces(ownerId), db.getTrees()]);
      const names = new Map(trees.filter((tree) => tree.ownerId === ownerId).map((tree) => [tree.id, tree.name]));
      return published.map((workspace) => ({ ...workspace, treeName: names.get(workspace.treeId) }));
    },
    changed: async (ownerId, _name, use) => {
      if (use.tools.length) await dependencyFollowers.tools?.rebuildNeeding(ownerId, use.tools);
      const servers = await db.getMcpServers(ownerId);
      for (const name of use.servers) {
        const server = servers.find((entry) => entry.name === name);
        if (server) await dependencyFollowers.servers?.recapture(ownerId, server.id);
      }
    },
  });
  const dependenciesOf = (ownerId: string) => workspaceDependencies.catalogue(ownerId);
  const agentDirectory = directoryFromDatabase(db, {
    stepNeeds: stepNeedsReader({ sources: { list: (ownerId?: string) => db.getProcedures(ownerId) }, published: (ownerId: string) => extensions.groups(ownerId) }),
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    onChanged: (ownerId: string) => void bench.service?.changed(ownerId).catch(() => undefined),
  });
  const engineRegistry = createStoredAgentRegistry({
    agents: agentDirectory,
    procedures: { list: (ownerId?: string) => db.getProcedures(ownerId) },
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
    accountDefault: async (ownerId: string) => accountDefaultOf(await db.getUserById(ownerId)),
  });
  const conversationTurns = new ConversationTurnService({
    store: db,
    log: db,
    running: async (runId) => {
      if (!temporalBridge.isReady()) return true;
      try {
        return (await temporalBridge.client.workflow.getHandle(workflowOfRun(runId)).describe()).status.name === 'RUNNING';
      } catch (err) {
        if (err instanceof WorkflowNotFoundError) return false;
        throw err;
      }
    },
  });
  const engineRuns = createRunStarter({
    registry: engineRegistry,
    turns: conversationTurns,
    ...(Number(process.env.ENGINE_CONTINUE_AFTER_EVENTS) > 0 ? { continueAfterEvents: Number(process.env.ENGINE_CONTINUE_AFTER_EVENTS) } : {}),
    workflows: () => (temporalBridge.isReady()
      ? {
        start: async (type, options) => {
          const handle = await temporalBridge.client.workflow.start(type, {
            workflowId: options.workflowId,
            taskQueue: options.taskQueue,
            args: options.args,
            memo: options.memo,
            ...startedFor(options.owner),
          });
          return { workflowId: handle.workflowId };
        },
        signal: async (workflowId, name, payload) => {
          await temporalBridge.client.workflow.getHandle(workflowId)
            .signal(name, ...(payload === undefined ? [] : [payload]));
        },
      }
      : undefined),
    binding: conversationBinding(db),
    closing: async (ownerId: string) => ((await db.getUserById(ownerId))?.removal ? 'it is being removed' : undefined),
    machines: (ownerId, choice) => machineService.choiceProblem(ownerId, choice),
  });
  const workspaceBuilds = new WorkspaceBuildService({
    runs: engineRuns,
    trees: () => db.getTrees(),
    hidden: (ownerId: string) => extensions.hidden(ownerId),
  });

  /**
   * The model call runs here rather than on the engine worker because this is the only process
   * holding browser sockets — tokens have to be produced next to whoever is watching them.
   */
  const bench: { service?: BenchService } = {};
  const agentsHolder: { service?: AgentService } = {};
  const workspaceRepos = createWorkspaceRepoResolver({ trees: () => db.getTrees(), projects: () => db.getProjects(), accountOf: async (ownerId) => (await db.getGiteaAccount(ownerId))?.username });
  const workspaceConclusions = new WorkspaceConclusionService({
    workflows: async () => (await getTemporalClient()).workflow,
    taskQueue: process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE,
  });
  const memoryKeeper = new MemoryKeeperService({
    store: db,
    start: async (request) => { await engineRuns.start(request); },
    timer: async ({ ownerId, conversationId, signal, quietMs }) => {
      const workflows = (await getTemporalClient()).workflow;
      const where = {
        workflowId: conversationConclusionId(conversationId),
        taskQueue: process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE,
        args: [{ ownerId, conversationId }],
        ...startedFor(ownerId),
      };
      if (signal === 'turnEnded') await workflows.signalWithStart(CONVERSATION_CONCLUSION_WORKFLOW, { ...where, signal, signalArgs: [{ quietMs: quietMs ?? 0 }] });
      else await workflows.signalWithStart(CONVERSATION_CONCLUSION_WORKFLOW, { ...where, signal, signalArgs: [] });
    },
    concludeAfterMinutes: async (ownerId, agentSlug) => (await engineRegistry.agent(ownerId, agentSlug))?.concludeAfterMinutes,
    remembersFor: async (ownerId: string) => {
      const user = await db.getUserById(ownerId);
      return Boolean(user) && !user!.space && !user!.removal;
    },
  });
  const reportMemory = (why: string) => (report: { started: string[] }) => {
    if (report.started.length > 0) console.log(`[memory] ${why}: started ${report.started.join(', ')}`);
  };
  const concluded = (ownerId: string, conversationId: string | undefined): void => {
    void memoryKeeper.settled(ownerId, conversationId).then(reportMemory('a conversation settled')).catch((err: Error) => console.warn(`[memory] ${err.message}`));
  };

  async function runningRecords(ownerId: string): Promise<RunningRecords> {
    const [trees, projects, conversations, checkRuns, releases, agents] = await Promise.all([
      db.getTrees(), db.getProjects(), db.getConversations(), level2Service.list(ownerId), db.getOdooReleases(ownerId), agentDirectory.agents(ownerId),
    ]);
    return {
      trees: trees.filter((entry) => entry.ownerId === ownerId),
      projects: projects.filter((entry) => entry.ownerId === ownerId),
      conversations: conversations.filter((entry) => entry.ownerId === ownerId),
      checkRuns: checkRuns.map((run) => ({ id: run.id, trigger: run.trigger as { kind?: string; agents?: string[] } | undefined, finished: run.finished, scenarios: run.scenarios })),
      releases,
      agentName: (slug) => agents.find((agent) => agent.slug === slug)?.name,
    };
  }
  const workFailures = new WorkFailureService({
    store: db,
    onFailure: (failure) => metrics.failed(failure.kind),
    workflows: {
      closedSince: async (since) => {
        if (!temporalBridge.isReady()) return [];
        const found: ClosedWorkflow[] = [];
        const query = `(ExecutionStatus = "Failed" OR ExecutionStatus = "TimedOut") AND CloseTime > "${since.toISOString()}"`;
        for await (const workflow of temporalBridge.client.workflow.list({ query })) {
          found.push({
            workflowId: workflow.workflowId,
            temporalRunId: workflow.runId,
            type: workflow.type,
            startedAt: workflow.startTime.toISOString(),
            closedAt: (workflow.closeTime ?? new Date()).toISOString(),
            status: workflow.status.name === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED',
            ownerId: ownerIn(workflow.typedSearchAttributes),
            ...(workflow.parentExecution?.workflowId ? { parent: workflow.parentExecution.workflowId } : {}),
            ...(workflow.memo ? { memo: workflow.memo } : {}),
          });
        }
        return found;
      },
      failureOf: async (workflowId, temporalRunId) => {
        try {
          await temporalBridge.client.workflow.getHandle(workflowId, temporalRunId).result();
          return undefined;
        } catch (err) {
          return { message: (err as Error).message, cause: { message: (err as { cause?: Error }).cause?.message } };
        }
      },
      describeRun: async (runId) => {
        if (!temporalBridge.isReady()) return undefined;
        const described = await temporalBridge.client.workflow.getHandle(workflowOfRun(runId)).describe();
        return { workflowId: described.workflowId, type: described.type, startedAt: described.startTime.toISOString(), ...(described.memo ? { memo: described.memo } : {}) };
      },
    },
    records: runningRecords,
    isPerson: async (ownerId) => {
      const user = await db.getUserById(ownerId);
      return Boolean(user) && !user!.space && !user!.removal;
    },
    log: (message) => console.warn(message),
  });

  if (servesTenants(role)) void keepTrying('[engine] stream worker not started yet, runs do not stream until it is', async () => {
    const worker = await startStreamWorker({
      io,
      turnLogs: db,
      encryptionKey: keys.payload,
      services: {
        registry: engineRegistry,
        endpoints: createEndpointResolver({ models: modelService, registry: engineRegistry }),
        streamNodes: hostNodesFor(createModelNodes({ registry: engineRegistry, models: modelService }), ['stream']),
        runCancelled: runCancelledVia(() => getTemporalClient()),
        conclude: async (event) => {
          const grown = event.kind === 'run-ended' ? grovedTree(event.runId, event.depth) : undefined;
          if (event.kind === 'run-ended' && grown) {
            postNotice('a tree stopped growing', (async () => {
              const tree = (await db.getTrees()).find((entry) => entry.id === grown && entry.ownerId === event.ownerId);
              if (!tree) return;
              const branchIds = new Set((await db.getBranches()).filter((branch) => branch.treeId === tree.id).map((branch) => branch.id));
              const leaves = (await db.getLeaves()).filter((leaf) => branchIds.has(leaf.branchId));
              const projectId = tree.projectIds?.[0];
              for (const notice of treeNotices({ id: tree.id, name: tree.name, ...(projectId ? { projectId } : {}) }, leaves, { runId: event.runId, outcome: event.outcome, ...(event.reason ? { reason: event.reason } : {}) })) {
                await notices.post(event.ownerId, { treeId: tree.id, projectId }, notice);
              }
            })());
          }
          if (event.kind === 'run-ended') await workFailures.runEnded(event).catch((err: Error) => console.warn(`[failures] ${err.message}`));
          reportMemory(event.kind)(await memoryKeeper.handle(event));
          await bench.service?.activity(event);
        },
        benchIdle: async (ownerId) => (bench.service ? bench.service.idle(ownerId) : 'nothing'),
        post: async (ownerId, posted) => {
          const notice = postedNotice(posted);
          if (notice) await notices.post(ownerId, { treeId: notice.refs.treeId, projectId: notice.refs.projectId }, notice);
        },
      },
    });
    void worker.run().catch((err: Error) =>
      console.warn(`[engine] stream worker stopped: ${err.message}`));
    console.log('[engine] stream worker polling engine-stream-queue');
  }, (message) => console.warn(message));

  const authService = new AuthService(db);
  app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
  app.use(cors({
    origin: (origin, callback) => callback(null, originAllowed(origin)),
    credentials: true,
  }));

  tenant.post('/webhooks/gitea/:projectId', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      const projects = await db.getProjects();
      const project = projects.find((p: any) => p.id === req.params.projectId);
      if (!project) return res.status(404).json({ error: 'Unknown project' });
      if (project.removal) return res.status(410).json({ error: 'This project is being deleted' });
      if (!project.webhookSecretEnc) return res.status(500).json({ error: 'Project has no webhook secret configured' });

      const secret = decryptValue(project.webhookSecretEnc, keys.data);
      const rawBody = req.body as Buffer;
      if (!giteaService.verifyWebhookSignature(rawBody, req.header('X-Gitea-Signature'), secret)) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }

      const payload = JSON.parse(rawBody.toString('utf8'));
      if (!payload.ref || !payload.after) return res.status(200).json({ status: 'ignored', reason: 'not a push event' });

      const ref = String(payload.ref).replace('refs/heads/', '');

      const defaultBranch = String(payload.repository?.default_branch ?? 'main');
      if (ref !== defaultBranch) {
        return res.status(200).json({ status: 'ignored', reason: `not the default branch (${ref} != ${defaultBranch})` });
      }

      res.status(202).json({ status: 'accepted' });
      temporalBridge.runPipeline(project, payload.after, ref).catch((err: any) =>
        console.error(`[webhook] Failed to start pipeline run for project ${project.id}: ${err.message}`)
      );
      workspaceBuilds.pushed(project, String(payload.after), Array.isArray(payload.commits) ? payload.commits : []).catch((err: any) =>
        console.error(`[webhook] Failed to start the workspace build for project ${project.id}: ${err.message}`)
      );
    } catch (err: any) {
      console.error(`[webhook] Gitea webhook error: ${err.message}`);
      res.status(500).json({ error: 'Internal error processing webhook' });
    }
  });

  app.use(express.json({ limit: '20mb' }));
  app.use(metrics.middleware());
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, hsts: process.env.NODE_ENV === 'production' }));
  app.use('/api', ...RATE_LIMITS.map((rule) => rateLimit({
    windowMs: rule.windowMs,
    limit: rule.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: rule.said },
    skip: (req) => ruleFor(req.path)?.name !== rule.name,
  })));
  const credentialService = new CredentialService(db, keys.data);
  const vpsCatalogService = new VpsCatalogService(db, keys.data);

  const auth = createAuth({ db, sessionKey: keys.session, publicUrl: PUBLIC_URL, role: role.role });
  const { requireAdmin, userFromSessionCookie } = auth;

  let runningNow: (() => Promise<string[] | 'unknown'>) | undefined;
  const moveExport = role.role === 'instance' && process.env.POOL === 'true' && role.trusted && role.instance ? new MoveExport({
    instanceId: role.instance.id,
    trusted: role.trusted,
    dataDir: path.join(__dirname, '../data'),
    mongo: mongoTarget(process.env),
    env: process.env,
    running: async () => (runningNow ? runningNow() : 'unknown'),
  }) : undefined;
  if (moveExport) {
    await moveExport.load();
    app.use('/api', (req, res, next) => (moveExport.isFrozen() && !answersWhileMoving(req.path)
      ? res.status(503).json({ error: 'This instance is moving to your own machine; it opens there once the move is done' })
      : next()));
    app.use('/api/move', moveRouter({ move: moveExport, log: (message) => console.warn(message) }));
  }

  app.use('/api', auth.requireAuth);
  app.get('/api/metrics', asyncRoute(async (req, res) => {
    if (!metrics.allowed(req.headers.authorization)) return res.status(401).json({ error: 'metrics are read with the METRICS_TOKEN' });
    res.type(metrics.contentType).send(await metrics.text());
  }));

  io.use(async (socket, next) => {
    if (process.env.IS_E2E === 'true') {
      const users = await db.getUsers();
      socket.data.user = users[0] || { id: 'test-user-id', email: 'test@example.com' };
      return next();
    }
    try {
      const user = await userFromSessionCookie(socket.handshake.headers.cookie);
      if (!user) return next(new Error('Unauthorized'));
      socket.data.user = user;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  const agentNamespace = io.of('/agent');
  const forMachines = machinePayloads({ ring: servesTenants(role) ? keys.payload : undefined, blobs: sharedPayloadBlobs() });
  agentNamespace.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Missing device token'));
    const device = findDeviceByToken(await db.getLocalAgentDevices(), token, keys.data);
    if (!device) return next(new Error('Unauthorized'));
    socket.data.device = device;
    next();
  });
  agentNamespace.on('connection', (socket) => {
    const device = socket.data.device as { id: string; ownerId: string; rootDir: string };
    const containerMode = socket.handshake.auth?.containerMode === true;
    registerDevice(device.id, device.ownerId, device.rootDir, socket, containerMode);
    db.getLocalAgentDevices().then((devices) => {
      const current = devices.find((d) => d.id === device.id);
      if (current) db.saveLocalAgentDevice({ ...current, lastSeenAt: new Date().toISOString() }).catch(() => undefined);
    }).catch(() => undefined);
    socket.on('disconnect', () => unregisterDevice(device.id, socket));
    socket.on('agents:found', (report: { agents?: unknown } | undefined) => {
      machineService.recordAgents(device.id, report?.agents).catch((err: Error) => console.warn(`[machines] ${device.id}: its agents could not be recorded: ${err.message}`));
    });
    socket.on('agents:manual', (_request: unknown, ack: (agents: unknown) => void) => {
      machineService.manualAgents(device.id).then(ack, () => ack([]));
    });
    socket.on('machine:payloads', (_request: unknown, ack: (answer: RingAnswer) => void) => ack(forMachines.ring()));
    socket.on('payloads:put', (request: unknown, ack: (answer: PutAnswer) => void) => { void forMachines.put(request).then(ack); });
    socket.on('payloads:get', (request: unknown, ack: (answer: GetAnswer) => void) => { void forMachines.get(request).then(ack); });
  });

  async function authorizeRoom(user: UserMetadata | undefined, id: string): Promise<any | undefined> {
    if (!user) return undefined;
    const cluster = await clusterService.getById(id, user.id);
    if (cluster) return cluster;
    const deployment = await appService.getById(id, user.id);
    if (deployment) return deployment;
    const run = (await db.getPipelineRuns()).find((r: any) => r.id === id);
    if (run) {
      const project = (await db.getProjects()).find((p: any) => p.id === run.projectId);
      const owned = ownsProject(project, user);
      if (owned && run.logFile) return { ...run, lastLogPath: run.logFile };
    }
    return undefined;
  }

  io.on('connection', (socket) => {
    const connectedUser = (socket.data.user as { id?: string } | undefined)?.id;
    if (connectedUser) void socket.join(userRoom(connectedUser));
    const socketTails = new Map<string, any>();

    socket.on('join-room', async (id) => {
      const resource = await authorizeRoom(socket.data.user, id);
      if (!resource) {
        socket.emit('room-denied', { id });
        return;
      }
      socket.join(id);

      const existing = socketTails.get(id);
      if (existing) {
        existing.kill();
        socketTails.delete(id);
      }

      if (resource.lastLogPath) {
        try {
          await fs.access(resource.lastLogPath);
        } catch {
          await fs.mkdir(path.dirname(resource.lastLogPath), { recursive: true }).catch(() => {});
          await fs.writeFile(resource.lastLogPath, '').catch(() => {});
        }

        const tail = spawn('tail', ['-n', String(LOG_TAIL_LINES), '-f', resource.lastLogPath]);
        socketTails.set(id, tail);

        tail.stdout.on('data', (data) => {
          socket.emit('log', data.toString());
        });

        tail.stderr.on('data', (data) => {
          socket.emit('log', data.toString());
        });

        tail.on('error', (err) => {
          console.warn(`[log-tail] ${resource.lastLogPath}: ${err.message}`);
          socketTails.delete(id);
        });

        tail.on('close', () => {
          socketTails.delete(id);
        });
      }
    });

    socket.on('join-kube-room', async (id) => {
      if (!(await authorizeRoom(socket.data.user, id))) {
        socket.emit('room-denied', { id });
        return;
      }
      socket.join(`${id}-kube`);
    });
    socket.on('tail-pod', async ({ resourceId, podName, namespace }) => {
      const user = socket.data.user as UserMetadata | undefined;
      if (!user) return;
      const dep = await appService.getById(resourceId, user.id);
      if (!dep) {
        socket.emit('room-denied', { id: resourceId });
        return;
      }
      const cluster = dep.clusterId === 'provisioning-lunorica'
        ? await clusterService.getSystemClusterEntry()
        : await clusterService.getById(dep.clusterId, user.id);
      if (!cluster) {
        socket.emit('room-denied', { id: resourceId });
        return;
      }
      let context: string | undefined;
      const isMock = clusterService.isMockCloud(cluster);
      const physicalName = clusterService.getPhysicalClusterName(cluster);
      if (cluster.provider === 'k3d' || isMock) context = `k3d-${physicalName}`;
      const kubeconfigPath = await clusterService.getKubeconfigPath(cluster);
      const args = ['logs', '-n', namespace || 'default', podName, '--all-containers=true', '--tail=100', '-f'];
      if (context) args.push('--context', context);
      infraService.streamLogs(resourceId, args, io, `${resourceId}-kube`, kubeconfigPath);
    });

    socket.on('leave-room', (id) => {
      socket.leave(id);
      const tail = socketTails.get(id);
      if (tail) {
        tail.kill();
        socketTails.delete(id);
      }
    });

    socket.on('leave-kube-room', (id) => { socket.leave(`${id}-kube`); infraService.stopStream(id); });

    socket.on('disconnect', () => {
      for (const tail of socketTails.values()) {
        tail.kill();
      }
      socketTails.clear();
    });
  });

  app.use('/api/auth', authRouter({
    db, authService, auth, sessionKey: keys.session, publicUrl: PUBLIC_URL, appUrl: APP_URL, accounts: holdsAccounts(role), hub: role.role === 'hub',
  }));
  if (holdsAccounts(role)) app.use('/api/identity', identityRouter({ identity, servesTenants: servesTenants(role), signedIn: (req) => auth.userFromSessionCookie(req.headers.cookie) }));
  if (holdsAccounts(role)) {
    const repoRoot = path.join(__dirname, '../../..');
    const instanceChart = new InstanceChart(repoRoot);
    const routingDomain = process.env.INGRESS_DOMAIN || undefined;
    const instanceRoutes = routingDomain
      ? new InstanceRoutes(db, routingDomain, path.join(__dirname, '../data/caddy'), dockerCaddy(process.env.CADDY_CONTAINER || 'nowrinkles-caddy', process.env.CADDY_TLS_ADDRESS || '127.0.0.1:443'), (message) => console.error(message))
      : undefined;
    const siteNames = [process.env.APP_DOMAIN, process.env.MESH_DOMAIN]
      .filter((site): site is string => Boolean(site && routingDomain && site.endsWith(`.${routingDomain}`)))
      .map((site) => site.slice(0, -(routingDomain!.length + 1)));
    const instanceService = new InstanceService(db, {
      rootUrl: PUBLIC_URL,
      rootPublicKeys: () => identity.publicKeys().map((key) => key.publicKey),
      meshLoginServer: process.env.MESH_LOGIN_SERVER,
      registry: process.env.INSTANCE_REGISTRY ?? '',
      imageTag: process.env.INSTANCE_IMAGE_TAG || 'dev',
      chartVersion: await instanceChart.version(),
      domain: routingDomain,
      siteNames,
      pool: (() => {
        const pool = poolSettingsFrom(process.env, '/tmp/kubeconfig-provisioning-lunorica');
        return 'off' in pool ? pool : { slots: pool.slots, trialDays: pool.trialDays };
      })(),
    }, headscaleService, () => new Date(), () => instanceRoutes?.changed(), {
      start: async (instanceId, ownerId) => {
        await (await getTemporalClient()).workflow.start('PoolInstanceWorkflow', {
          workflowId: `pool-instance-${instanceId}`,
          taskQueue: process.env.POOL_TASK_QUEUE || 'host-ops-queue',
          args: [{ instanceId }],
          ...startedFor(ownerId),
        });
      },
      trialChanged: async (instanceId) => {
        await (await getTemporalClient()).workflow.getHandle(poolTrialWorkflowId(instanceId)).signal(TRIAL_CHANGED).catch((error: Error) => {
          if (!/not found|already completed/i.test(error.message)) throw error;
        });
      },
      remove: async (instanceId, ownerId) => {
        const temporal = await getTemporalClient();
        await temporal.workflow.start('PoolRemoveWorkflow', {
          workflowId: poolRemoveWorkflowId(instanceId),
          taskQueue: process.env.POOL_TASK_QUEUE || 'host-ops-queue',
          args: [{ instanceId }],
          ...startedFor(ownerId),
        });
      },
      move: async (instanceId, ownerId) => {
        await (await getTemporalClient()).workflow.start('PoolMoveWorkflow', {
          workflowId: poolMoveWorkflowId(instanceId),
          taskQueue: process.env.POOL_TASK_QUEUE || 'host-ops-queue',
          args: [{ instanceId }],
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          ...startedFor(ownerId),
        });
      },
      moveFinished: async (instanceId) => {
        await (await getTemporalClient()).workflow.getHandle(poolMoveWorkflowId(instanceId)).signal(MOVE_FINISHED);
      },
      moveStopped: async (instanceId, reason) => {
        await (await getTemporalClient()).workflow.getHandle(poolMoveWorkflowId(instanceId)).signal(MOVE_STOPPED, reason);
      },
    });
    instanceRoutes?.start();
    const poolWatched = poolSettingsFrom(process.env, '/tmp/kubeconfig-provisioning-lunorica');
    const poolMonitoring = 'off' in poolWatched ? undefined : new PoolMonitoringService({
      kubectl: async (args) => String(await infraService.runKubectl(args, poolWatched.kubeconfig)),
      apply: async (manifest) => { await infraService.applyManifest(manifest, poolWatched.kubeconfig); },
    });
    const moveRelay = 'off' in poolWatched || !role.signing ? undefined : new MoveRelay({
      kubeconfig: kubeconfigFile(poolWatched.kubeconfig),
      sign: (instanceId, part) => issueMoveToken(role.signing!, instanceId, part),
    });
    const hubAccess = role.signing && role.hubLink
      ? async (instanceId: string, ownerId: string) => {
        const owner = await db.getUserById(ownerId);
        if (!owner) return undefined;
        return { token: issueMoveToken(role.signing!, HUB_AUDIENCE, hubInstancePart(instanceId, ownerId, owner.email)), hubUrl: role.hubLink!.url, personId: ownerId, email: owner.email, instanceId };
      }
      : undefined;
    app.use('/api/instances', instancesRouter({ instances: instanceService, chart: () => instanceChart.path(), mail, requireAdmin, poolMonitoring, moveRelay, hubAccess }));
    const installer = (await fs.readFile(path.join(repoRoot, 'scripts/instance/install.sh'), 'utf8')).replace('__ROOT_URL__', PUBLIC_URL);
    app.get('/install.sh', (_req, res) => res.type('text/x-shellscript').send(installer));
    app.get('/install/setup-gpu.sh', (_req, res) => res.type('text/x-shellscript').sendFile(path.join(repoRoot, 'scripts/setup-gpu.sh')));
  }
  if (signsInThroughRoot(role.role)) app.use('/api/auth', handoffRouter({ identity, auth, sessionKey: keys.session }));
  const hub = await wireHub({
    role, env: process.env, app, tenant, db, mail, publicUrl: PUBLIC_URL, dataKey: keys.data, gitea: giteaService,
    notify: (ownerId, scope, notice) => notices.post(ownerId, scope, notice),
  });

  tenant.get('/ingress/verify', async (req, res) => {
    const domain = String(req.query.domain ?? '');
    if (!domain) return res.status(400).send('domain required');
    const deployments = await db.getDeployments();
    const owned = deployments.some((d) => d.isExposedPublicly && d.publicHostname === domain);
    return owned ? res.status(200).send('ok') : res.status(404).send('unknown host');
  });

  tenant.use('/api/instance-addresses', instanceAddressesRouter({ addresses: () => instanceAddresses }));
  tenant.use('/api/instance-trial', instanceTrialRouter({
    trial: role.instance && process.env.INSTANCE_CREDENTIAL
      ? new InstanceTrial({ rootUrl: role.instance.rootUrl, instanceId: role.instance.id, credential: process.env.INSTANCE_CREDENTIAL })
      : undefined,
  }));
  const systemOwners = async (): Promise<string[]> => (role.instance
    ? [role.instance.ownerId]
    : (await db.getUsers()).filter((user) => user.isAdmin).map((user) => user.id));
  const { monitoring } = wireMonitoring({ tenant, db, role, env: process.env, io, clusters: clusterService, infra: infraService, proxy: clusterProxyService, notices, notifications, mail, systemOwners });
  tenant.use('/api/credentials', llmCredentialsRouter({ db, dataKey: keys.data, credentialService, publicUrl: PUBLIC_URL, appUrl: APP_URL }));
  tenant.use('/api/credentials', credentialsRouter({
    credentialService,
    publicUrl: PUBLIC_URL,
    appUrl: APP_URL,
  }));
  tenant.use('/api/backup', backupRouter({ repoRoot: path.join(__dirname, '../../..') }));

  tenant.use('/api/clusters', clustersRouter({
    clusterService, appService, clusterProxyService, infraService,
    temporalBridge, db, io, giteaService, infisicalService, dataKey: keys.data,
  }));
  tenant.use('/api/deployments', deploymentsRouter({
    appService, clusterService, appExposureService, infraService, temporalBridge, db, io,
  }));

  const getOwnedProject = async (id: string, user: any): Promise<any | undefined> => {
    const project = (await db.getProjects()).find((p: any) => p.id === id);
    return project && ownsProject(project, user) ? project : undefined;
  };

  async function webTools() {
    return resolveWebTools({
      db,
      serviceUrl: (clusterId, serviceKey, kubeconfigPath, target) =>
        clusterProxyService.serviceUrl(clusterId, serviceKey, kubeconfigPath, target),
      kubeconfigFor: async (clusterId: string) => {
        const cluster = await clusterService.getByIdUnscoped(clusterId);
        return cluster ? clusterService.getKubeconfigPath(cluster) : undefined;
      },
    });
  }

  async function executeWebSearch(query: string): Promise<SearchOutcome> {
    return (await webTools()).search(query);
  }

  async function executeFetchWebPage(url: string): Promise<string> {
    return (await webTools()).fetchPage(url);
  }

  function toolRefused(result: string): boolean {
    try {
      return Boolean(JSON.parse(result)?.error);
    } catch {
      return true;
    }
  }

  const ownedBranches = async (userId: string) => ownedBy(await db.getBranches(), userId);
  const ownedLeaves = async (userId: string) => ownedBy(await db.getLeaves(), userId);
  const ownedTrees = async (userId: string) => ownedBy(await db.getTrees(), userId);



  const NGINX_CONF_PATH = path.join(__dirname, '../data/nginx/nginx.conf');

  const workerService = new WorkerService();

  const projectRemoval = new ProjectRemovalService({
    store: db,
    hub: {
      shared: async (projectId) => (hub.sharingService ? hub.sharingService.shared(projectId) : false),
      takeBack: async (ownerId, projectId) => { await hub.sharingService?.takeBackForDeletion(ownerId, projectId); },
    },
    workflows: temporalRemovalWorkflows<{ projectId: string }, ProjectRemovalStep>(() => temporalBridge.client, process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE, PROJECT_REMOVAL_PROGRESS_QUERY),
  });
  tenant.use('/api/projects', projectsRouter({
    db, projectRepoService, appService, temporalBridge, getOwnedProject,
    giteaService, clusterService, infraService, dataKey: keys.data, removal: projectRemoval, channels,
  }));
  tenant.use('/api/items', itemChatsRouter({ items: itemChats }));
  tenant.use('/api/projects', projectChannelRouter({ channels, conversations: async (ownerId) => (await db.getConversations()).filter((conversation) => conversation.ownerId === ownerId), getOwnedProject }));
  const files = wireFiles({ tenant, db, reach: artifactStore.reach, temporalBridge, projectRepos: projectRepoService, gitea: giteaService, getOwnedProject });
  const releases = wireReleases({
    tenant, db, io, gitea: giteaService, infra: infraService, clusters: clusterService, projectRepos: projectRepoService, temporalBridge,
    runs: engineRuns, notices, postNotice, secrets: projectSecrets, agents: agentDirectory, registry: engineRegistry,
    exposure: appExposureService, channels, getOwnedProject,
  });
  const { odooReleases, releaseSettings, customizations } = releases;
  tenant.use('/api/artifacts', artifactsRouter({ artifacts: artifactStore.artifacts, hasMinio: (ownerId) => artifactStore.minio.hasMinio(ownerId) }));
  const sweepArtifacts = () => artifactStore.artifacts.sweep().catch((err: Error) => console.warn(`[artifacts] the sweep failed: ${err.message}`));
  setInterval(sweepArtifacts, 24 * 60 * 60 * 1000).unref();
  void sweepArtifacts();
  wireMachines({ tenant, db, dataKey: keys.data, publicUrl: PUBLIC_URL, repoRoot: path.join(__dirname, '../../..'), machines: machineService, headscale: headscaleService, projectRepos: projectRepoService });
  tenant.use('/api/pending-approvals', pendingApprovalsRouter({ db }));
  tenant.use('/api/cluster-providers', clusterProvidersRouter({ db }));
  tenant.use('/api/vps-catalog', vpsCatalogRouter({ vpsCatalogService }));
  const accountRemoval = servesTenants(role) ? new AccountRemovalService({
    store: db,
    workflows: temporalRemovalWorkflows(() => temporalBridge.client, process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE),
    hub: hub.hubPeople,
  }) : undefined;
  tenant.use('/api/checks', checksRouter({ scripted: new ScriptedModelService({ store: db, dataKey: keys.data }) }));
  const rootRemoval = holdsAccounts(role) && !servesTenants(role) ? new AccountRemovalService({
    store: db,
    workflows: temporalRemovalWorkflows(() => getTemporalClient(), process.env.POOL_TASK_QUEUE || 'host-ops-queue'),
    workflowType: ROOT_REMOVAL_WORKFLOW,
    steps: ROOT_REMOVAL_STEPS,
    instances: () => db.getInstances(),
    hub: hub.hubPeople,
  }) : undefined;
  const peopleRemoval = rootRemoval ?? accountRemoval;
  if (holdsAccounts(role) && peopleRemoval) app.use('/api/account', accountRouter({ removal: peopleRemoval, clearSession: (res) => res.clearCookie('session', auth.sessionCookieOptions) }));
  if (holdsAccounts(role)) app.use('/api/admin', adminRouter({ db, requireAdmin, ...(peopleRemoval ? { removal: peopleRemoval } : {}) }));
  tenant.use('/api/models', modelsRouter({ modelService, db, credentialService, machines: machineService, rateLimits: getModelRateLimiterSnapshot }));
  tenant.use('/api/temporal', temporalRouter({ temporalBridge, instanceOwner: role.instance?.ownerId }));
  tenant.use('/api/worker', workerRouter({ workerService }));
  tenant.use('/api/nginx', nginxRouter({ infraService, nginxConfPath: NGINX_CONF_PATH }));
  tenant.use('/api/logs', logsRouter({ db, clusterService, appService }));
  tenant.use('/api/registry', registryRouter({ registryService }));
  tenant.use('/api/modules', modulesRouter({ gitModuleService }));
  tenant.use('/api/app-schemas', appSchemasRouter({}));

  const ownedConversations = async (userId: string) =>
    (await db.getConversations()).filter((c) => c.ownerId === userId);

  /**
   * The harness is how a draft tool gets evaluated toward approval, so it is the one caller that
   * sees drafts. Production stays approved-only.
   */
  const draftRegistry = createStoredAgentRegistry({
    agents: agentDirectory,
    procedures: { list: (ownerId?: string) => db.getProcedures(ownerId) },
    tools: { list: (ownerId?: string) => db.getEngineTools(ownerId) },
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
  });

  const draftCatalogue = createStoredToolCatalogue({
    tools: { list: (ownerId?: string) => db.getEngineTools(ownerId) },
  });

  const evalWeb = await buildWebTools(db).catch(() => undefined);
  const evalHost = createEngineHost({
    dependencies: dependenciesOf,
    customizations: { drift: (...args) => customizations.drift(...args), propose: (...args) => customizations.propose(...args), exportItems: (...args) => customizations.exportItems(...args) },
    treeModels: {
      describe: (ownerId, treeId) => treeModels.describe(ownerId, treeId),
      problem: (ownerId, treeId, agent, modelId) => treeModels.problem(ownerId, treeId, agent, modelId),
    },
    mcpServers: {
      list: (ownerId) => db.getMcpServers(ownerId),
      get: async (ownerId, id) => (await db.getMcpServers(ownerId)).find((server) => server.id === id),
      save: (server) => db.saveMcpServer(server),
      hostedUrl: hostedMcpUrl({ deployments: () => db.getDeployments(), probeUrl: resolveMcpProbeUrl }),
    },
    publishedWorkspaces: { get: (ownerId: string, treeId: string) => db.getPublishedWorkspace(ownerId, treeId), save: (workspace) => db.savePublishedWorkspace(workspace) },
    readRepoFile: async (ownerId: string, repo: string, path: string, ref: string) => (await projectRepoService.readDocument(ownerId, repo, path, ref))?.content,
    writeRepoFile: (ownerId, repo, path, content, message, branch) => projectRepoService.putDocument(ownerId, repo, path, content, message, branch),
    workspaceBuild: (ownerId, treeId, commit) => workspaceBuilds.start(ownerId, treeId, commit),
    treeLanguage: treeLanguageFrom(db),
    treeExtras: treeExtrasFrom(db, dependencyNamespaceFrom(db)),
    artifacts: { keep: (ownerId, runId, files) => artifactStore.artifacts.put(ownerId, runId, files) },
    checks: httpCheckAccess(async (ownerId) => {
      const person = await db.getUserById(ownerId);
      if (!person) throw new Error(`there is no account ${ownerId} to act for`);
      return axios.create({ baseURL: `http://localhost:${process.env.PORT || 3001}/api`, proxy: false, headers: { Cookie: `session=${signJWT({ userId: person.id, email: person.email }, keys.session, 60 * 60)}` } });
    }),
    documents: { push: (request) => projectRepoService.pushDocuments(request), pull: (request) => projectRepoService.pullDocuments(request), merge: (request) => projectRepoService.mergeDocuments(request), pushBranch: (request) => projectRepoService.pushBranch(request), pullBranch: (request) => projectRepoService.pullBranch(request), deleteBranch: (request) => projectRepoService.deleteBranch(request) },
    repoFor: workspaceRepos,
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
    models: modelService,
    stores: storesFromDatabase(db),
    owners: async () => (await db.getUsers()).map((user) => user.id),
    ...(evalWeb ? { web: evalWeb } : {}),
    kubeconfig: process.env.KUBECONFIG_PATH,
    registryHost: process.env.KOALA_REGISTRY,
    pushRegistryHost: process.env.KOALA_REGISTRY_PUSH,
    registryAccount: async () => ({
      owner: giteaService.adminUsername,
      ...(await giteaService.getAdminCredentials()),
    }),
    registryPushToken: async () => ({
      username: giteaService.adminUsername,
      password: (await giteaService.createDeployToken()).token,
    }),
    efforts: { save: (effort) => db.saveRunEffort(effort), list: (ownerId, procedureId, modelKey) => db.getRunEffort(ownerId, procedureId, modelKey) },
  });
  if (evalHost.storyDrops) files.setStoryDrops(storyDropsFor({ db, projectRepos: projectRepoService, gitea: giteaService, work: evalHost.storyDrops }));

  const practiceService = new PracticeService({ store: db });
  const toolNoteService = new PracticeService({ store: db, category: 'tool_note' });
  const agentChanges = new AgentChangeService({
    store: db,
    savePrompt: async (ownerId, slug, prompt) => {
      const current = await engineRegistry.agent(ownerId, slug);
      if (!current || !agentsHolder.service) return { saved: false, problems: [`there is no agent called "${slug}"`] };
      const saved = await agentsHolder.service.save(ownerId, { ...current, prompt });
      return saved.saved ? { saved: true } : { saved: false, problems: saved.problems };
    },
    handOff: async (ownerId, message) => {
      const at = new Date().toISOString();
      const conversationId = randomUUID();
      await db.saveConversation({ id: conversationId, ownerId, title: 'Procedure change request', messages: [], agentSlug: PROCEDURE_CHANGE_AGENT, createdAt: at, updatedAt: at });
      const started = await engineRuns.start({ ownerId, agentSlug: PROCEDURE_CHANGE_AGENT, procedureId: 'interactive-chat', message, conversationId, inputs: { conversationId } });
      return { conversationId, runId: started.runId };
    },
  });
  const agentFingerprints = async (ownerId: string, agents: readonly string[]): Promise<Record<string, string>> => Object.fromEntries((await Promise.all(agents.map(async (slug) => {
    const runnable = await engineRegistry.runnable(ownerId, slug).catch(() => undefined);
    return runnable ? [slug, fingerprintOf({ agent: runnable.agent, procedure: runnable.procedure })] as const : undefined;
  }))).filter((entry): entry is readonly [string, string] => entry !== undefined));

  const level2Service: Level2Service = new Level2Service({
    fingerprints: agentFingerprints,
    checks: temporalCheckRunner(() => temporalBridge.client, process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE),
    tools: (ownerId: string) => draftCatalogue.list(ownerId),
    agents: async (ownerId: string) => (await draftRegistry.agents(ownerId)).map((agent) => agent.slug),
    procedures: async (ownerId: string) => (await engineRegistry.procedures(ownerId)).map((procedure) => procedure.id),
    store: db,
    onFinished: async (run) => { await bench.service?.finished(run); },
  });

  bench.service = new BenchService({
    store: db,
    scenarios: async (ownerId) => (await level2Service.scenarios(ownerId)).map((scenario) => ({ id: scenario.id, agent: scenario.agent, onBench: scenario.onBench, tools: scenarioSubjects(scenario).tools })),
    fingerprints: agentFingerprints,
    practices: practiceService,
    notes: toolNoteService,
    changes: agentChanges,
    earlier: (run) => level2Service.earlier(run),
    notifyChange: (ownerId, change) => {
      io.to(`user:${ownerId}`).emit('agent-change-ready', { id: change.id, agent: change.agent, better: change.comparison?.better ?? [], worse: change.comparison?.worse ?? [] });
    },
    start: async (ownerId, plan, extra) => {
      const started = await level2Service.start({ ownerId, only: plan.scenarioIds, trigger: plan.trigger, ...extra });
      if ('unknown' in started) throw new Error(`the bench names scenarios that no longer exist: ${started.unknown.join(', ')}`);
      console.log(`[bench] ${ownerId}: started ${plan.trigger.kind} run ${started.id} (${plan.scenarioIds.length} scenarios)`);
    },
    serving: async (ownerId, model) => {
      const provider = providerServing(await modelService.list(ownerId), model);
      return provider ? { modelId: provider.id, modelLabel: provider.name } : undefined;
    },
    benchRunning: async (ownerId) => (await level2Service.list(ownerId)).some((run) => run.state === 'running'),
    agentsRunning: async () => {
      const client = await getTemporalClient();
      for await (const _run of client.workflow.list({ query: 'WorkflowType = "AgentRunWorkflow" AND ExecutionStatus = "Running"' })) return true;
      return false;
    },
    idleTimer: async (ownerId, idleMs) => {
      await (await getTemporalClient()).workflow.signalWithStart(BENCH_IDLE_WORKFLOW, {
        workflowId: benchIdleId(ownerId),
        taskQueue: process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE,
        args: [{ ownerId }],
        ...startedFor(ownerId),
        signal: 'benchActivity',
        signalArgs: [{ idleMs }],
      });
    },
    notify: (ownerId, run) => {
      io.to(`user:${ownerId}`).emit('bench-regression', { runId: run.id, regressions: run.regressions ?? [], trigger: run.trigger });
    },
  });

  if (servesTenants(role)) await level2Service.recover().catch(() => undefined);
  if (servesTenants(role)) void db.getUsers().then((users) => odooReleases.recover(users.map((user) => user.id))).catch(() => undefined);

  void evalHost.workspaceImages.warm().then((images) => {
    const building = images.filter((image) => image.state === 'building');
    const failed = images.filter((image) => image.state === 'failed');
    if (building.length > 0) console.log(`[images] building ${building.length} workspace ${building.length === 1 ? 'image' : 'images'} ahead of the first run`);
    for (const image of failed) console.warn(`[images] ${image.agent}: ${image.detail ?? 'the image could not be built'}`);
  }).catch((err: Error) => console.warn(`[images] could not warm workspace images: ${err.message}`));

  /**
   * Let go of the workspace images nothing would run. What it takes is not lost: a fingerprint is
   * derived from what the agents need, so the next run that wants an image names it and builds it
   * again — which is why this can be a sweep rather than an accounting.
   */
  const sweepImages = async (why: string): Promise<void> => {
    if (!evalHost.imagePruner) return;

    try {
      const report = await evalHost.imagePruner.prune();
      if (report.removed.length === 0 && report.failed.length === 0) return;
      console.log(`[images] ${why}: let go of ${report.removed.length}, kept ${report.kept.length}, left ${report.tooNew.length} too new`);
      for (const failure of report.failed) {
        console.warn(`[images] ${why}: could not delete ${failure.fingerprint.slice(0, 12)}: ${failure.detail}`);
      }
    } catch (err) {
      console.warn(`[images] ${why}: could not sweep the workspace images: ${(err as Error).message}`);
    }
  };

  const payloadStorage = new PayloadStorageService(sharedPayloadBlobs(), () => getTemporalClient());
  const sweepPayloads = async (): Promise<void> => {
    try {
      const report = await payloadStorage.sweep();
      if (report.released.length > 0 || report.orphans > 0) {
        console.log(`[payloads] released the stored payloads of ${report.released.length} finished workflows and ${report.orphans} unowned ones; ${report.kept} still in Temporal`);
      }
    } catch (err) {
      console.warn(`[payloads] could not sweep stored Temporal payloads: ${(err as Error).message}`);
    }
  };

  if (servesTenants(role)) {
    setTimeout(() => { void sweepPayloads(); }, PRUNE_FIRST_DELAY_MS).unref();
    setInterval(() => { void sweepPayloads(); }, PRUNE_INTERVAL_MS).unref();
    setTimeout(() => { void sweepImages('after the warm'); }, PRUNE_FIRST_DELAY_MS).unref();
    setInterval(() => { void sweepImages('daily'); }, PRUNE_INTERVAL_MS).unref();
  }

  const procedureService = new ProcedureService({
      hidden: (ownerId: string) => extensions.hidden(ownerId),
      published: (ownerId: string) => extensions.groups(ownerId),
      procedures: createProcedureStore({ sources: { list: (ownerId?: string) => db.getProcedures(ownerId) }, published: (ownerId: string) => extensions.groups(ownerId) }),
      sources: {
        get: (ownerId, id) => db.getProcedure(ownerId, id),
        save: async (source) => {
          await db.saveProcedure(source);
          if (source.ownerId) void bench.service?.changed(source.ownerId).catch(() => undefined);
        },
        delete: (ownerId, id) => db.deleteProcedure(ownerId, id),
      },
      known: async (ownerId) => ({
        tools: await (async () => {
          const hidden = await extensions.hidden(ownerId);
          return new Set((await draftCatalogue.names(ownerId)).filter((name) => !hidden.tools.has(name)));
        })(),
        agents: new Set((await engineRegistry.agents(ownerId)).map((agent) => agent.slug)),
      }),
      effort: { list: (ownerId, procedureId) => db.getRunEffort(ownerId, procedureId) },
  });
  tenant.use('/api/procedures', proceduresRouter({ procedures: procedureService }));

  const autoModeService = new AutoModeService({ store: db, agentExists: async (ownerId, slug) => Boolean(await engineRegistry.agent(ownerId, slug)) });
  tenant.use('/api/engine', engineRouter({
    runs: engineRuns,
    projects: async (ownerId) => (await db.getProjects()).filter((project) => project.ownerId === ownerId).map((project) => ({ id: project.id, name: project.name })),
    approvals: new ApprovalService({ store: db, runs: engineRuns, autoMode: autoModeService, treeOfRun: treeOfGroveRun }),
    registry: engineRegistry,
    admin: requireAdmin,
    extensions,
    images: {
      standing: (ownerId?: string) => evalHost.workspaceImages.standing(ownerId),
      prune: async () => evalHost.imagePruner?.prune(),
    },
    traces: { list: (ownerId: string, runId: string) => db.getRunTraces(ownerId, runId) },
    tasks: {
      list: (ownerId: string) => db.getTasks(ownerId),
      save: (task) => db.saveTask(task),
    },
    ...(evalHost.acceptedNeeds ? { accepted: evalHost.acceptedNeeds } : {}),
  }));

  tenant.use('/api/engine-tools', engineToolsRouter({
    tools: dependencyFollowers.tools = new EngineToolService({
      catalogue: draftCatalogue,
      dependencies: dependenciesOf,
      tools: {
        list: (ownerId?: string) => db.getEngineTools(ownerId),
        save: (tool) => db.saveEngineTool(tool),
        remove: (ownerId, name) => db.deleteEngineTool(ownerId, name),
      },
      agents: agentDirectory,
      servers: (ownerId: string) => db.getMcpServers(ownerId),
      implemented: evalHost.implemented,
      images: evalHost.images,
    }),
  }));

  tenant.use('/api/agents', agentsRouter({
    agents: agentsHolder.service = new AgentService({
      agents: agentDirectory,
      records: {
        save: async (record: PersonaRecord) => {
          await db.saveEnginePersona(record);
          if (record.ownerId) void bench.service?.changed(record.ownerId).catch(() => undefined);
        },
        remove: (ownerId: string | undefined, slug: string) => db.deleteEnginePersona(ownerId, slug),
      },
      tools: (ownerId: string) => draftCatalogue.list(ownerId),
      procedures: (ownerId: string) => engineRegistry.procedures(ownerId),
      treeTypes: async (ownerId: string) => treeTypeChoices(await db.getTreeTypes(ownerId), ownerId),
      servers: (ownerId: string) => db.getMcpServers(ownerId),
      dependencies: dependenciesOf,
      images: evalHost.images,
    }),
  }));

  tenant.use('/api/evals/level2', evalsLevel2Router({ level2: level2Service, bench: bench.service!, practices: practiceService, notes: toolNoteService, changes: agentChanges }));

  tenant.use('/api/conversations', conversationsRouter({
    db,
    workspaces: {
      conclude: (ownerId: string, conversationId: string) => workspaceConclusions.conclude(ownerId, { kind: 'conversation', id: conversationId }),
      ...(evalHost.conversationWorkspaces ? { state: (conversationId: string) => evalHost.conversationWorkspaces!.state(conversationId) } : {}),
    },
    turns: conversationTurns,
    posted: (ownerId, conversationId) => { io.to(`user:${ownerId}`).emit('conversation-message', { conversationId }); },
    binding: conversationBinding(db),
    ownedConversations,
    ownedTrees,
    ownedProjects: async (userId: string) => (await db.getProjects()).filter((project) => project.ownerId === userId),
  }));

  const documentService = new DocumentService({
    repoFor: workspaceRepos,
    owns: async (userId, kind, id) => (kind === 'tree'
      ? (await ownedTrees(userId)).some((tree) => tree.id === id)
      : (await ownedConversations(userId)).some((conversation) => conversation.id === id)),
    read: (userId, repo, path, ref) => projectRepoService.readDocument(userId, repo, path, ref),
  });
  tenant.use('/api/documents', documentsRouter({ documents: documentService }));
  tenant.use('/api/turns', turnsRouter({ log: { read: (ownerId, turnId, after) => db.getTurnLog(ownerId, turnId, after), recent: (ownerId, since, limit) => db.recentTurns(ownerId, since, limit) } }));

  tenant.use('/api/memories', memoriesRouter({ db, temporalBridge }));

  const treeTypeDescriptions = new TreeTypeDescriptions({
    dependencies: dependenciesOf,
    releaseAgents: (ownerId) => releaseSettings.agents(ownerId),
    restores: restoringApp,
    treeTypes: (ownerId) => db.getTreeTypes(ownerId),
    images: (ownerId) => new WorkspaceImageService(db).list(ownerId),
    agentOf: async (ownerId, slug) => {
      const runnable = await engineRegistry.runnable(ownerId, slug);
      return runnable && { describe: runnable.agent.description, procedure: runnable.procedure };
    },
  });
  tenant.use('/api/tree-types', treeTypesRouter({ db, agents: async (ownerId: string) => (await engineRegistry.agents(ownerId)).map((agent) => agent.slug), describe: (ownerId, typeId) => treeTypeDescriptions.describe(ownerId, typeId), releaseProblem: (ownerId, how) => releaseSettings.problem(ownerId, how) }));
  tenant.use('/api/binding-types', bindingTypesRouter({ db }));
  const treeModels = new TreeModelsService({ store: db, models: modelService, agentOf: treeAgentsFrom(engineRegistry), machines: (ownerId) => machineService.list(ownerId), groups: platformGroups });
  const groveRuns = new GroveRunService({
    store: db,
    asking: runAskingVia(() => getTemporalClient()),
    ...(evalHost.checkNeeds ? { checkNeeds: evalHost.checkNeeds } : {}),
    launcher: createGroveLauncher({
      hidden: (ownerId: string) => extensions.hidden(ownerId),
      runs: engineRuns,
      client: () => (temporalBridge.isReady() ? temporalBridge.client.workflow : undefined),
      agentFor: async (ownerId: string, treeId: string) => {
        const tree = (await db.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
        return groveAgentOf(await resolveTreeType(db, ownerId, tree?.type));
      },
      leafRun: async (leafId: string) => (await db.getLeaves()).find((leaf) => leaf.id === leafId)?.runId,
      modelFor: (ownerId, treeId, agentSlug) => treeModels.modelFor(ownerId, treeId, agentSlug),
    }),
  });
  const treeConclusions = { release: (treeId: string, ownerId: string) => workspaceConclusions.conclude(ownerId, { kind: 'tree', id: treeId }) };
  const groveDeletion = new GroveDeletionService({
    store: db,
    workflows: { stop: (workflowId, reason) => temporalBridge.stopIfRunning(workflowId, reason) },
    workspaces: treeConclusions,
  });
  const groveOrder = new GroveOrderService({ store: db });
  tenant.use('/api/auto-mode', autoModeRouter({
    autoMode: autoModeService,
  }));
  const treeWorkspace = evalHost.treeWorkspaceFiles ? new TreeWorkspaceService({
    trees: () => db.getTrees(),
    files: evalHost.treeWorkspaceFiles.files,
    compose: evalHost.treeWorkspaceFiles.compose,
    published: (ownerId, treeId) => db.getPublishedWorkspace(ownerId, treeId),
    builds: (ownerId) => db.getRunEffort(ownerId, BUILD_WORKSPACE.id),
    startBuild: (ownerId, treeId, commit) => workspaceBuilds.start(ownerId, treeId, commit),
  }) : undefined;
  const waitingOf = runWaitingVia(() => getTemporalClient());
  const running = new RunningService({
    workflows: {
      list: async (ownerId) => {
        if (!temporalBridge.isReady()) return undefined;
        const found: RunningWorkflow[] = [];
        for await (const workflow of temporalBridge.client.workflow.list({ query: `${ownedQuery(ownerId)} AND ExecutionStatus = "Running"` })) {
          found.push({
            workflowId: workflow.workflowId,
            type: workflow.type,
            startedAt: workflow.startTime.toISOString(),
            ...(workflow.parentExecution?.workflowId ? { parent: workflow.parentExecution.workflowId } : {}),
            ...(workflow.memo ? { memo: workflow.memo } : {}),
          });
        }
        return found;
      },
      waiting: (workflowId) => waitingOf(workflowId),
      cancel: (workflowId) => temporalBridge.cancelWorkflow(workflowId),
    },
    records: runningRecords,
    checks: { cancel: (ownerId, id) => level2Service.cancel(ownerId, id) },
    trees: { stop: async (ownerId, treeId) => { const outcome = await groveRuns.stop(ownerId, treeId); return outcome.ok ? { ok: true } : { ok: false, error: outcome.error }; } },
    runs: { cancel: (runId) => engineRuns.cancel(runId) },
    bench: {
      settings: async (ownerId) => (bench.service ? bench.service.settings(ownerId) : { ...DEFAULT_BENCH_SETTINGS }),
      saveSettings: async (ownerId, value) => (bench.service ? bench.service.saveSettings(ownerId, value) : { saved: false, problems: ['the bench is not set up here'] }),
    },
    keeper: memoryKeeper,
  });
  runningNow = async () => {
    const view = await running.view(role.instance?.ownerId ?? '');
    if (!view.ok) return 'unknown';
    return view.value.items.map((item) => item.title);
  };
  tenant.use('/api/running', runningRouter({ running }));
  const clusterContents = new ClusterContentsService({
    monitoring,
    deployments: () => db.getDeployments(),
    kubectl: async (cluster, args) => String(await infraService.runKubectl(args, await clusterService.getKubeconfigPath(cluster))),
    helm: async (cluster, args) => String(await infraService.runHelm(args, await clusterService.getKubeconfigPath(cluster))),
    labelOf: labelValue,
  });
  tenant.use('/api/infrastructure', infrastructureRouter({
    infrastructure: new InfrastructureViewService({ monitoring, contents: clusterContents, running, failures: workFailures }),
  }));
  if (servesTenants(role)) workFailures.start();
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
        const repo = await workspaceRepos(treeWorkspaceRunId(treeId));
        const account = await db.getGiteaAccount(ownerId);
        if (!repo || !account) return [];
        return (await giteaService.findRepo(account.username, repo.repo)) ? giteaService.pullRequests(account.username, repo.repo) : [];
      },
    },
  }));
  const planService = new PlanService({ store: db, adopter: temporalBridge, onSettled: concluded, stories: async (ownerId) => (await db.getLeaves()).filter((leaf) => leaf.ownerId === ownerId).map((leaf) => ({ id: leaf.id, title: leaf.title, status: leaf.status })) });
  tenant.use('/api/plans', plansRouter({ plans: planService }));
  tenant.use('/api/secret-requests', secretRequestsRouter({ secrets: new SecretRequestService({ store: db, vault: infisicalService }) }));
  tenant.use('/api/branches', branchesRouter({ db, deletion: groveDeletion, order: groveOrder }));
  if (hub.reaches) {
    hub.setWork(hubInstanceWork({
      db, releases: odooReleases, treeRuns: groveRuns, plans: planService, order: groveOrder, accepted: evalHost.acceptedNeeds,
      itemChats, runs: engineRuns, procedures: procedureService, extensions, files: files.fileService,
    }));
  }

  const mcpCatalogue = dependencyFollowers.servers = new McpServerService({
    dependencies: dependenciesOf,
    store: { list: (ownerId) => db.getMcpServers(ownerId), save: (server) => db.saveMcpServer(server), remove: (ownerId, id) => db.deleteMcpServer(ownerId, id) },
    templates: () => MCP_SERVER_TEMPLATES,
    runs: engineRuns,
    finished: async (runId) => db.findRunEffort(runId),
    deployments: () => db.getDeployments(),
    grants: agentDirectory,
    notes: toolNoteService,
    names: async (ownerId, deployment) => {
      const project = deployment.gitappProjectId ? (await db.getProjects()).find((entry) => entry.id === deployment.gitappProjectId && entry.ownerId === ownerId) : undefined;
      const tree = project ? (await db.getTrees()).find((entry) => entry.ownerId === ownerId && (entry.projectIds ?? []).includes(project.id)) : undefined;
      return { ...(tree?.name ? { treeName: tree.name } : {}), ...(project?.name ? { projectName: project.name } : {}), declared: (tree as { serviceName?: unknown } | undefined)?.serviceName as string | undefined };
    },
  });
  tenant.use('/api/workspace-dependencies', workspaceDependenciesRouter({ dependencies: workspaceDependencies }));
  tenant.use('/api/mcp', mcpRouter({ mcp: new McpService({ store: db, catalogue: (ownerId) => db.getMcpServers(ownerId) }), catalogue: mcpCatalogue }));
  tenant.use('/api/actions', actionsRouter({ actions: new ActionService({
    store: db,
    deployer: temporalBridge,
    releases: releaseSettings,
    treeModels,
    alerts: {
      add: (ownerId, deploymentId, spec, conversationId) => monitoring.addRule({ id: ownerId }, deploymentId, spec, conversationId),
      remove: (ownerId, ruleId) => monitoring.removeRule({ id: ownerId }, ruleId),
    },
    servers: { add: (ownerId, input) => mcpCatalogue.add(ownerId, input), list: (ownerId) => db.getMcpServers(ownerId) },
    dependencies: workspaceDependencies,
    agents: {
      agents: (ownerId) => agentDirectory.agents(ownerId),
      holdServer: async (ownerId, slug, server, meta) => {
        if (!agentsHolder.service) throw new Error('agents cannot be changed yet');
        return agentsHolder.service.holdServer(ownerId, slug, server, meta);
      },
      image: async (ownerId, slug) => agentsHolder.service?.image(ownerId, slug),
    },
    onSettled: concluded,
  }) }));
  const egressService = new EgressService({
    store: db,
    proxy: new EgressProxyService({ kube: infraService, secret: keys.egress, kubeconfig: '/tmp/kubeconfig-provisioning-lunorica' }),
  });
  tenant.use('/api/egress', egressRouter({ egress: egressService }));
  tenant.use('/api/cluster-access', clusterAccessRouter({ access: new AccessService({ store: db }) }));
  if (process.env.NODE_ENV !== 'test') {
    egressService.syncProxy().catch((err: Error) => console.warn(`[egress] could not sync the proxy's grants: ${err.message}`));
  }

  tenant.use('/api/leaves', leavesRouter({ db, runs: groveRuns, deletion: groveDeletion }));

  if (process.env.NODE_ENV !== 'test') {
    appExposureService.syncExposedApps().catch((e) => {
      const err = e instanceof Error ? e.message : String(e);
      console.error(`Failed to sync exposed apps to nginx: ${err}`);
    });
  }

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(__dirname, '../../frontend/dist');
    if (fsSync.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
      console.log(`📦 Serving the frontend from ${distPath}`);
    } else {
      console.warn(`⚠️  NODE_ENV=production but no frontend build at ${distPath} — run \`npm run build\`.`);
    }
  }

  if (process.env.NODE_ENV !== 'test' || process.env.IS_E2E === 'true') {
    const hostTunnelPort = process.env.IS_E2E === 'true' ? 8001 : 8000;
    startHostTunnel(hostTunnelPort);
    httpServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${port} is already in use by another process. Run 'npm run clean-dev' or free port ${port}.`);
        process.exit(1);
      }
      console.error(`Provisioning Server Error: ${err.message}`);
      process.exit(1);
    });
    httpServer.listen(port, () => console.log(`🚀 Provisioning Server Active on http://localhost:${port}`));
  }

  const shutdown = () => { clusterProxyService.stopAll(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, io, temporalBridge, db };
}

if (process.env.NODE_ENV !== 'test' || process.env.IS_E2E === 'true') {
  bootstrap().catch(console.error);
}
