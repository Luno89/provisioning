import { WorkflowNotFoundError } from '@temporalio/client';
import { PROCEDURE_CHANGE_AGENT } from './lib/agent-usage.js';
import { getModelRateLimiterSnapshot } from '@koala/agent-engine';
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
import { engineRouter } from './routes/engine.js';
import { proceduresRouter } from './routes/procedures.js';
import { ProcedureService } from './services/ProcedureService.js';
import { createProcedureStore } from './engine-host/registries/procedure-store.js';
import { createModelNodes, createProcedureExecutor, hostNodesFor } from './engine-host/nodes/index.js';
import { agentsRouter } from './routes/agents.js';
import { engineToolsRouter } from './routes/engine-tools.js';
import { EngineToolService } from './services/EngineToolService.js';
import { AgentService } from './services/AgentService.js';
import { evalsLevel2Router } from './routes/evals-level2.js';
import { buildWebTools } from './lib/web-tools-wiring.js';
import { Level2Service, temporalCheckRunner } from './services/Level2Service.js';
import { createStoredToolCatalogue, createEngineHost, storesFromDatabase, createStoredAgentRegistry, createEndpointResolver, createRunStarter, startStreamWorker } from './engine-host/index.js';
import { userRoom } from './engine-host/temporal/stream-worker.js';
import { createWorkspaceRepoResolver, treeWorkspaceRunId } from './engine-host/sandboxes/workspace-repos.js';
import { PRUNE_FIRST_DELAY_MS, PRUNE_INTERVAL_MS } from './engine-host/sandboxes/prune-images.js';
import { conversationBinding } from './engine-host/conversation-binding.js';
import { runCancelledVia } from './engine-host/temporal/run-cancellation.js';
import { getTemporalClient, resolveOwnersWith } from './lib/temporal-client.js';
import { PayloadStorageService } from './services/PayloadStorageService.js';
import { withHints } from './lib/mcp-tool-hints.js';
import { MemoryKeeperService } from './services/MemoryKeeperService.js';
import { BENCH_IDLE_WORKFLOW, CONVERSATION_CONCLUSION_WORKFLOW, DEFAULT_ENGINE_TASK_QUEUE, benchIdleId, conversationConclusionId } from './engine-host/temporal/contracts.js';
import { BenchService } from './services/BenchService.js';
import { PracticeService } from './services/PracticeService.js';
import { randomUUID } from 'node:crypto';
import { AgentChangeService } from './services/AgentChangeService.js';
import { fingerprintOf } from './lib/bench.js';
import { createAuth } from './middleware/auth.js';
import { projectsRouter } from './routes/projects.js';
import { projectFilesRouter } from './routes/project-files.js';
import { meshRouter } from './routes/mesh.js';
import { localAgentsRouter } from './routes/local-agents.js';
import { pendingApprovalsRouter } from './routes/pending-approvals.js';
import { startedFor } from './lib/workflow-owner.js';
import { findDeviceByToken, registerDevice, unregisterDevice } from './lib/local-agent-registry.js';
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
import { ClusterProxyService } from './services/ClusterProxyService.js';
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

import { McpRegistryService } from './services/McpRegistryService.js';
import { resolveMcpProbeUrl } from './lib/mcp-probe-url.js';
import { resolveWebTools } from './lib/web-tools-resolver.js';
import { seedAll } from './scripts/seed-all.js';
import type { SearchOutcome } from './lib/web-tools.js';
import { createGroveLauncher } from './engine-host/grove-launcher.js';
import { groveAgentOf, resolveTreeType, treeTypeChoices, treeLanguageFrom } from './lib/tree-types.js';
import { endpointRulesFromEnv } from './lib/endpoint-url-safety.js';
import { AccountRemovalService, temporalRemovalWorkflows } from './services/AccountRemovalService.js';
import { ProjectRemovalService } from './services/ProjectRemovalService.js';
import { PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from './lib/project-removal.js';
import { accountRouter } from './routes/account.js';
import { checksRouter } from './routes/checks.js';
import { ScriptedModelService } from './services/ScriptedModelService.js';
import { extensionServiceFor } from './services/ExtensionService.js';
import { loadKeys } from './lib/keys.js';
import { signJWT } from './lib/auth.js';
import { roleFromEnv, servesTenants, holdsAccounts } from './lib/platform-role.js';
import { IdentityService } from './services/IdentityService.js';
import { identityRouter } from './routes/identity.js';
import { handoffRouter } from './routes/handoff.js';
import { InstanceService } from './services/InstanceService.js';
import { InstanceChart } from './services/InstanceChart.js';
import { instancesRouter } from './routes/instances.js';
import { OdooReleaseService, temporalReleaseWorkflows } from './services/OdooReleaseService.js';
import { releasesRouter } from './routes/releases.js';
import { artifactsRouter } from './routes/artifacts.js';
import { CHART_FILE } from './lib/odoo-release.js';
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
  const appExposureService = new AppExposureService(db, infraService, clusterService, io);
  const clusterProxyService = new ClusterProxyService();
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
  const projectRepoService = new ProjectRepoService(db, giteaService, keys.data);
  const headscaleService = new HeadscaleService(keys.data, process.env.HEADSCALE_URL || 'http://localhost:8080');
  const modelService = new ModelService(db, appService, clusterService, clusterProxyService, headscaleService, keys.data, endpointRulesFromEnv(process.env));


  clusterService.ensureSystemClusterGpuReady().catch((err: any) =>
    console.warn(`[bootstrap] System cluster GPU readiness check failed: ${err.message}`)
  );

  const temporalBridge = new TemporalBridge(db, io, keys.data, clusterService, headscaleService);
  clusterService.setTemporalBridge(temporalBridge);
  appService.setTemporalBridge(temporalBridge);
  if (servesTenants(role)) {
    try {
      await temporalBridge.start();
      await temporalBridge.startActiveWorkflowRecovery();
    } catch (e: any) {
      console.warn(`⚠️ Temporal TS bridge not available. Routes will fall back to Local DB.`, e.message);
    }
  }

  const extensions = extensionServiceFor(db);
  const engineRegistry = createStoredAgentRegistry({
    personas: { list: (ownerId?: string) => db.getEnginePersonas(ownerId) },
    procedures: { list: (ownerId?: string) => db.getProcedures(ownerId) },
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
  });
  const conversationTurns = new ConversationTurnService({
    store: db,
    log: db,
    running: async (runId) => {
      if (!temporalBridge.isReady()) return true;
      try {
        return (await temporalBridge.client.workflow.getHandle(runId).describe()).status.name === 'RUNNING';
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

  if (servesTenants(role)) startStreamWorker({
    io,
    turnLogs: db,
    encryptionKey: keys.payload,
    services: {
      registry: engineRegistry,
      endpoints: createEndpointResolver({ models: modelService, registry: engineRegistry }),
      streamNodes: hostNodesFor(createModelNodes({ registry: engineRegistry, models: modelService }), ['stream']),
      runCancelled: runCancelledVia(() => getTemporalClient()),
      conclude: async (event) => {
        reportMemory(event.kind)(await memoryKeeper.handle(event));
        await bench.service?.activity(event);
      },
      benchIdle: async (ownerId) => (bench.service ? bench.service.idle(ownerId) : 'nothing'),
    },
  })
    .then((worker) => {
      void worker.run().catch((err: Error) =>
        console.warn(`[engine] stream worker stopped: ${err.message}`));
      console.log('[engine] stream worker polling engine-stream-queue');
    })
    .catch((err: Error) =>
      console.warn(`[engine] stream worker not started (${err.message}) — runs will not stream until Temporal is reachable`));

  const authService = new AuthService(db);
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
    } catch (err: any) {
      console.error(`[webhook] Gitea webhook error: ${err.message}`);
      res.status(500).json({ error: 'Internal error processing webhook' });
    }
  });

  app.use(express.json({ limit: '20mb' }));
  const credentialService = new CredentialService(db, keys.data);
  const vpsCatalogService = new VpsCatalogService(db, keys.data);

  const auth = createAuth({ db, sessionKey: keys.session, publicUrl: PUBLIC_URL, role: role.role });
  const { requireAdmin, userFromSessionCookie } = auth;

  app.use('/api', auth.requireAuth);

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
    db, authService, auth, sessionKey: keys.session, publicUrl: PUBLIC_URL, appUrl: APP_URL, accounts: holdsAccounts(role),
  }));
  if (holdsAccounts(role)) app.use('/api/identity', identityRouter({ identity, servesTenants: servesTenants(role), signedIn: (req) => auth.userFromSessionCookie(req.headers.cookie) }));
  if (holdsAccounts(role)) {
    const repoRoot = path.join(__dirname, '../../..');
    const instanceChart = new InstanceChart(repoRoot);
    const instanceService = new InstanceService(db, {
      rootUrl: PUBLIC_URL,
      rootPublicKeys: () => identity.publicKeys().map((key) => key.publicKey),
      meshLoginServer: process.env.MESH_LOGIN_SERVER,
      registry: process.env.INSTANCE_REGISTRY ?? '',
      imageTag: process.env.INSTANCE_IMAGE_TAG || 'dev',
      chartVersion: await instanceChart.version(),
    }, headscaleService);
    app.use('/api/instances', instancesRouter({ instances: instanceService, chart: () => instanceChart.path() }));
    const installer = (await fs.readFile(path.join(repoRoot, 'scripts/instance/install.sh'), 'utf8')).replace('__ROOT_URL__', PUBLIC_URL);
    app.get('/install.sh', (_req, res) => res.type('text/x-shellscript').send(installer));
    app.get('/install/setup-gpu.sh', (_req, res) => res.type('text/x-shellscript').sendFile(path.join(repoRoot, 'scripts/setup-gpu.sh')));
  }
  if (role.role === 'instance') app.use('/api/auth', handoffRouter({ identity, auth, sessionKey: keys.session }));

  tenant.get('/ingress/verify', async (req, res) => {
    const domain = String(req.query.domain ?? '');
    if (!domain) return res.status(400).send('domain required');
    const deployments = await db.getDeployments();
    const owned = deployments.some((d) => d.isExposedPublicly && d.publicHostname === domain);
    return owned ? res.status(200).send('ok') : res.status(404).send('unknown host');
  });

  tenant.use('/api/credentials', llmCredentialsRouter({ db, dataKey: keys.data, credentialService }));
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
      ensurePortForward: (clusterId, serviceKey, kubeconfigPath, target) =>
        clusterProxyService.ensurePortForward(clusterId, serviceKey, kubeconfigPath, target),
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
    workflows: temporalRemovalWorkflows<{ projectId: string }, ProjectRemovalStep>(() => temporalBridge.client, process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE, PROJECT_REMOVAL_PROGRESS_QUERY),
  });
  tenant.use('/api/projects', projectsRouter({
    db, projectRepoService, appService, temporalBridge, getOwnedProject,
    giteaService, clusterService, infraService, dataKey: keys.data, removal: projectRemoval,
  }));
  tenant.use('/api/projects', projectFilesRouter({ projectRepoService, giteaService, getOwnedProject }));
  const odooReleases = new OdooReleaseService({
    store: db,
    workflows: temporalReleaseWorkflows(() => temporalBridge.client, process.env.TEMPORAL_TASK_QUEUE || 'cluster-ops-queue'),
    chartAt: async (owner, repo, commit) => (await giteaService.getRawFile(owner, repo, CHART_FILE, commit)) !== null,
    clusterById: async (id) => (id === 'provisioning-lunorica' ? clusterService.getSystemClusterEntry() : (await db.getClusters()).find((cluster) => cluster.id === id)),
    notify: (ownerId, release) => { io.to(`user:${ownerId}`).emit('odoo-release-updated', release); },
  });
  temporalBridge.onBuilt = async (project, run) => {
    if (!(await odooReleases.releasesByChart(project, run.commitSha))) return false;
    const started = await odooReleases.release(project, run);
    if ('error' in started) console.error(`[releases] ${project.name}: the build of ${run.commitSha} was not released: ${started.error}`);
    return true;
  };
  tenant.use('/api/projects', releasesRouter({ releases: odooReleases, getOwnedProject }));
  tenant.use('/api/artifacts', artifactsRouter({ artifacts: artifactStore.artifacts, hasMinio: (ownerId) => artifactStore.minio.hasMinio(ownerId) }));
  const sweepArtifacts = () => artifactStore.artifacts.sweep().catch((err: Error) => console.warn(`[artifacts] the sweep failed: ${err.message}`));
  setInterval(sweepArtifacts, 24 * 60 * 60 * 1000).unref();
  void sweepArtifacts();
  tenant.use('/api/mesh', meshRouter({ headscaleService, db }));
  tenant.use('/api/mesh/local-agents', localAgentsRouter({ db, dataKey: keys.data, projects: projectRepoService }));
  tenant.use('/api/pending-approvals', pendingApprovalsRouter({ db }));
  tenant.use('/api/cluster-providers', clusterProvidersRouter({ db }));
  tenant.use('/api/vps-catalog', vpsCatalogRouter({ vpsCatalogService }));
  const accountRemoval = servesTenants(role) ? new AccountRemovalService({
    store: db,
    workflows: temporalRemovalWorkflows(() => temporalBridge.client, process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE),
  }) : undefined;
  tenant.use('/api/checks', checksRouter({ scripted: new ScriptedModelService({ store: db, dataKey: keys.data }) }));
  if (accountRemoval) tenant.use('/api/account', accountRouter({ removal: accountRemoval, clearSession: (res) => res.clearCookie('session', auth.sessionCookieOptions) }));
  app.use('/api/admin', adminRouter({ db, requireAdmin, ...(accountRemoval ? { removal: accountRemoval } : {}) }));
  tenant.use('/api/models', modelsRouter({ modelService, db, credentialService, rateLimits: getModelRateLimiterSnapshot }));
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
    personas: { list: (ownerId?: string) => db.getEnginePersonas(ownerId) },
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
    treeLanguage: treeLanguageFrom(db),
    artifacts: { keep: (ownerId, runId, files) => artifactStore.artifacts.put(ownerId, runId, files) },
    checks: httpCheckAccess(async (ownerId) => {
      const person = await db.getUserById(ownerId);
      if (!person) throw new Error(`there is no account ${ownerId} to act for`);
      return axios.create({ baseURL: `http://localhost:${process.env.PORT || 3001}/api`, proxy: false, headers: { Cookie: `session=${signJWT({ userId: person.id, email: person.email }, keys.session, 60 * 60)}` } });
    }),
    documents: { push: (request) => projectRepoService.pushDocuments(request), pull: (request) => projectRepoService.pullDocuments(request), merge: (request) => projectRepoService.mergeDocuments(request) },
    repoFor: workspaceRepos,
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
    models: modelService,
    stores: storesFromDatabase(db),
    owners: async () => (await db.getUsers()).map((user) => user.id),
    ...(evalWeb ? { web: evalWeb } : {}),
    kubeconfig: process.env.KUBECONFIG_PATH,
    registryHost: process.env.KOALA_REGISTRY,
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

  const practiceService = new PracticeService({ store: db });
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
    scenarios: async (ownerId) => (await level2Service.scenarios(ownerId)).map((scenario) => ({ id: scenario.id, agent: scenario.agent })),
    fingerprints: agentFingerprints,
    practices: practiceService,
    changes: agentChanges,
    earlier: (run) => level2Service.earlier(run),
    notifyChange: (ownerId, change) => {
      io.to(`user:${ownerId}`).emit('agent-change-ready', { id: change.id, agent: change.agent, better: change.comparison?.better ?? [], worse: change.comparison?.worse ?? [] });
    },
    start: async (ownerId, plan, extra) => {
      const started = await level2Service.start({ ownerId, only: plan.scenarioIds, trigger: plan.trigger, ...(extra?.trialPractice ? { trialPractice: extra.trialPractice } : {}), ...(extra?.promptOverride ? { promptOverride: extra.promptOverride } : {}) });
      if ('unknown' in started) throw new Error(`the bench names scenarios that no longer exist: ${started.unknown.join(', ')}`);
      console.log(`[bench] ${ownerId}: started ${plan.trigger.kind} run ${started.id} (${plan.scenarioIds.length} scenarios)`);
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

  tenant.use('/api/procedures', proceduresRouter({
    procedures: new ProcedureService({
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
        tools: new Set((await engineRegistry.tools(ownerId)).map((tool) => tool.name)),
        agents: new Set((await engineRegistry.agents(ownerId)).map((agent) => agent.slug)),
      }),
      effort: { list: (ownerId, procedureId) => db.getRunEffort(ownerId, procedureId) },
    }),
  }));

  tenant.use('/api/engine', engineRouter({
    runs: engineRuns,
    approvals: new ApprovalService({ store: db, runs: engineRuns }),
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
  }));

  tenant.use('/api/engine-tools', engineToolsRouter({
    tools: new EngineToolService({
      catalogue: draftCatalogue,
      tools: {
        list: (ownerId?: string) => db.getEngineTools(ownerId),
        save: (tool) => db.saveEngineTool(tool),
        remove: (ownerId, name) => db.deleteEngineTool(ownerId, name),
      },
      personas: { list: (ownerId?: string) => db.getEnginePersonas(ownerId) },
      implemented: evalHost.implemented,
      images: evalHost.images,
    }),
  }));

  tenant.use('/api/agents', agentsRouter({
    agents: agentsHolder.service = new AgentService({
      personas: {
        list: (ownerId?: string) => db.getEnginePersonas(ownerId),
        save: async (persona) => {
          await db.saveEnginePersona(persona);
          if (persona.ownerId) void bench.service?.changed(persona.ownerId).catch(() => undefined);
        },
        remove: (ownerId, slug) => db.deleteEnginePersona(ownerId, slug),
      },
      tools: (ownerId: string) => draftCatalogue.list(ownerId),
      procedures: (ownerId: string) => engineRegistry.procedures(ownerId),
      treeTypes: async (ownerId: string) => treeTypeChoices(await db.getTreeTypes(ownerId), ownerId),
      mcpServers: async (ownerId: string) => [...new Set((await new McpRegistryService(db, ownerId, (n: string) => resolveMcpProbeUrl(n)).list()).map((server) => server.name))],
      images: evalHost.images,
    }),
  }));

  tenant.use('/api/evals/level2', evalsLevel2Router({ level2: level2Service, bench: bench.service!, practices: practiceService, changes: agentChanges }));

  tenant.use('/api/conversations', conversationsRouter({
    db,
    workspaces: {
      conclude: (ownerId: string, conversationId: string) => workspaceConclusions.conclude(ownerId, { kind: 'conversation', id: conversationId }),
      ...(evalHost.conversationWorkspaces ? { state: (conversationId: string) => evalHost.conversationWorkspaces!.state(conversationId) } : {}),
    },
    turns: conversationTurns,
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

  tenant.use('/api/tree-types', treeTypesRouter({ db, agents: async (ownerId: string) => (await engineRegistry.agents(ownerId)).map((agent) => agent.slug) }));
  tenant.use('/api/binding-types', bindingTypesRouter({ db }));
  const groveRuns = new GroveRunService({
    store: db,
    launcher: createGroveLauncher({
      hidden: (ownerId: string) => extensions.hidden(ownerId),
      runs: engineRuns,
      client: () => (temporalBridge.isReady() ? temporalBridge.client.workflow : undefined),
      agentFor: async (ownerId: string, treeId: string) => {
        const tree = (await db.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
        return groveAgentOf(await resolveTreeType(db, ownerId, tree?.type));
      },
      leafRun: async (leafId: string) => (await db.getLeaves()).find((leaf) => leaf.id === leafId)?.runId,
    }),
  });
  const treeConclusions = { release: (treeId: string, ownerId: string) => workspaceConclusions.conclude(ownerId, { kind: 'tree', id: treeId }) };
  const groveDeletion = new GroveDeletionService({
    store: db,
    workflows: { stop: (workflowId, reason) => temporalBridge.stopIfRunning(workflowId, reason) },
    workspaces: treeConclusions,
  });
  tenant.use('/api/trees', treesRouter({
    db,
    workspaces: { state: (treeId) => evalHost.treeWorkspaces.state(treeId), ...treeConclusions },
    runs: groveRuns,
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
  tenant.use('/api/plans', plansRouter({ plans: new PlanService({ store: db, adopter: temporalBridge, onSettled: concluded }) }));
  tenant.use('/api/secret-requests', secretRequestsRouter({ secrets: new SecretRequestService({ store: db, vault: infisicalService }) }));
  tenant.use('/api/branches', branchesRouter({ db, deletion: groveDeletion }));

  const mcpRegistries = new Map<string, McpRegistryService>();
  const mcpServersOf = (ownerId: string) => {
    const known = mcpRegistries.get(ownerId) ?? new McpRegistryService(db, ownerId, (n: string) => resolveMcpProbeUrl(n));
    mcpRegistries.set(ownerId, known);
    return Promise.all([known.listWithTools(), db.getMcpToolHints(ownerId)]).then(([servers, hints]) => withHints(servers, hints));
  };
  tenant.use('/api/mcp', mcpRouter({ mcp: new McpService({ store: db, servers: mcpServersOf }) }));
  tenant.use('/api/actions', actionsRouter({ actions: new ActionService({ store: db, deployer: temporalBridge, onSettled: concluded }) }));
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
