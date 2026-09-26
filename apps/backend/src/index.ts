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
import { evalsLevel1Router } from './routes/evals-level1.js';
import { evalsLevel2Router } from './routes/evals-level2.js';
import { buildWebTools } from './lib/web-tools-wiring.js';
import { Level1Service } from './services/Level1Service.js';
import { Level2Service } from './services/Level2Service.js';
import { createStoredToolCatalogue, createEngineHost, storesFromDatabase, createStoredAgentRegistry, createEndpointResolver, createRunStarter, startStreamWorker } from './engine-host/index.js';
import { conversationBinding } from './engine-host/conversation-binding.js';
import { runCancelledVia } from './engine-host/temporal/run-cancellation.js';
import { getTemporalClient } from './lib/temporal-client.js';
import { createAuth } from './middleware/auth.js';
import { projectsRouter } from './routes/projects.js';
import { projectFilesRouter } from './routes/project-files.js';
import { meshRouter } from './routes/mesh.js';
import { localAgentsRouter } from './routes/local-agents.js';
import { pendingApprovalsRouter } from './routes/pending-approvals.js';
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
import { createDatabase, type Database } from './lib/db-interface.js';
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
import { AuthService } from './services/AuthService.js';
import { CredentialService } from './services/CredentialService.js';
import { GiteaService } from './services/GiteaService.js';
import { InfisicalService } from './services/InfisicalService.js';
import { ProjectRepoService } from './services/ProjectRepoService.js';
import { HeadscaleService } from './services/HeadscaleService.js';
import { ModelService } from './services/ModelService.js';
import { decryptValue } from './lib/crypto.js';

import { McpRegistryService } from './services/McpRegistryService.js';
import { resolveMcpProbeUrl } from './lib/mcp-probe-url.js';
import { preferUsable } from './lib/mcp-registry.js';
import { resolveWebTools } from './lib/web-tools-resolver.js';
import { seedAll } from './scripts/seed-all.js';
import type { SearchOutcome } from './lib/web-tools.js';

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
  await migrateLegacyOwnership(db);
  await seedAll(db as never);

  const JWT_SECRET = process.env.JWT_SECRET || 'provisioning-platform-secret-12345';
  const infraService = new InfrastructureService();
  const builderService = new BuilderService(db, infraService);
  const clusterService = new ClusterService(db, infraService, JWT_SECRET);
  const appService = new AppService(db, infraService, clusterService, builderService);
  const registryService = new RegistryService(db);
  const gitModuleService = new GitModuleService(db);
  const appExposureService = new AppExposureService(db, infraService, clusterService, io);
  const clusterProxyService = new ClusterProxyService();
  const giteaService = new GiteaService(infraService, JWT_SECRET, '/tmp/kubeconfig-provisioning-lunorica');
  await giteaService.ensureClusterSecret().catch((err: Error) =>
    console.warn(`[gitea] could not ensure cluster secret: ${err.message}`),
  );
  const infisicalService = new InfisicalService(
    infraService,
    JWT_SECRET,
    '/tmp/kubeconfig-provisioning-lunorica',
    undefined,
    clusterProxyService,
  );
  const projectRepoService = new ProjectRepoService(db, giteaService, JWT_SECRET);
  const headscaleService = new HeadscaleService(JWT_SECRET, process.env.HEADSCALE_URL || 'http://localhost:8080');
  const modelService = new ModelService(db, appService, clusterService, clusterProxyService, headscaleService, JWT_SECRET);


  clusterService.ensureSystemClusterGpuReady().catch((err: any) =>
    console.warn(`[bootstrap] System cluster GPU readiness check failed: ${err.message}`)
  );

  const temporalBridge = new TemporalBridge(db, io, JWT_SECRET, clusterService, headscaleService);
  clusterService.setTemporalBridge(temporalBridge);
  appService.setTemporalBridge(temporalBridge);
  try {
    await temporalBridge.start();
    await temporalBridge.startActiveWorkflowRecovery();
  } catch (e: any) {
    console.warn(`⚠️ Temporal TS bridge not available. Routes will fall back to Local DB.`, e.message);
  }

  const engineRegistry = createStoredAgentRegistry({
    personas: { list: (ownerId?: string) => db.getEnginePersonas(ownerId) },
    procedures: { list: (ownerId?: string) => db.getProcedures(ownerId) },
  });
  const engineRuns = createRunStarter({
    registry: engineRegistry,
    workflows: () => (temporalBridge.isReady()
      ? {
        start: async (type, options) => {
          const handle = await temporalBridge.client.workflow.start(type, {
            workflowId: options.workflowId,
            taskQueue: options.taskQueue,
            args: options.args,
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
  });

  /**
   * The model call runs here rather than on the engine worker because this is the only process
   * holding browser sockets — tokens have to be produced next to whoever is watching them.
   */
  startStreamWorker({
    io,
    encryptionKey: JWT_SECRET,
    services: {
      registry: engineRegistry,
      endpoints: createEndpointResolver({ models: modelService, registry: engineRegistry }),
      streamNodes: hostNodesFor(createModelNodes({ registry: engineRegistry, models: modelService }), ['stream']),
      runCancelled: runCancelledVia(() => getTemporalClient()),
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

  app.post('/webhooks/gitea/:projectId', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      const projects = await db.getProjects();
      const project = projects.find((p: any) => p.id === req.params.projectId);
      if (!project) return res.status(404).json({ error: 'Unknown project' });
      if (!project.webhookSecretEnc) return res.status(500).json({ error: 'Project has no webhook secret configured' });

      const secret = decryptValue(project.webhookSecretEnc, JWT_SECRET);
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
  const credentialService = new CredentialService(db, JWT_SECRET);
  const vpsCatalogService = new VpsCatalogService(db, JWT_SECRET);

  const auth = createAuth({ db, jwtSecret: JWT_SECRET, publicUrl: PUBLIC_URL });
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
    const device = findDeviceByToken(await db.getLocalAgentDevices(), token, JWT_SECRET);
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
    db, authService, auth, jwtSecret: JWT_SECRET, publicUrl: PUBLIC_URL, appUrl: APP_URL,
  }));

  app.get('/ingress/verify', async (req, res) => {
    const domain = String(req.query.domain ?? '');
    if (!domain) return res.status(400).send('domain required');
    const deployments = await db.getDeployments();
    const owned = deployments.some((d) => d.isExposedPublicly && d.publicHostname === domain);
    return owned ? res.status(200).send('ok') : res.status(404).send('unknown host');
  });

  app.use('/api/credentials', llmCredentialsRouter({ db, jwtSecret: JWT_SECRET, credentialService }));
  app.use('/api/credentials', credentialsRouter({
    credentialService,
    publicUrl: PUBLIC_URL,
    appUrl: APP_URL,
  }));
  app.use('/api/backup', backupRouter({ repoRoot: path.join(__dirname, '../../..') }));

  app.use('/api/clusters', clustersRouter({
    clusterService, appService, clusterProxyService, infraService,
    temporalBridge, db, io, giteaService, infisicalService, jwtSecret: JWT_SECRET,
  }));
  app.use('/api/deployments', deploymentsRouter({
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

  app.use('/api/projects', projectsRouter({
    db, projectRepoService, appService, temporalBridge, getOwnedProject,
    giteaService, clusterService, infraService, jwtSecret: JWT_SECRET,
  }));
  app.use('/api/projects', projectFilesRouter({ projectRepoService, giteaService, getOwnedProject }));
  app.use('/api/mesh', meshRouter({ headscaleService, db, jwtSecret: JWT_SECRET }));
  app.use('/api/mesh/local-agents', localAgentsRouter({ db, jwtSecret: JWT_SECRET, projects: projectRepoService }));
  app.use('/api/pending-approvals', pendingApprovalsRouter({ db }));
  app.use('/api/cluster-providers', clusterProvidersRouter({ db }));
  app.use('/api/vps-catalog', vpsCatalogRouter({ vpsCatalogService }));
  app.use('/api/admin', adminRouter({ db, requireAdmin }));
  app.use('/api/models', modelsRouter({ modelService, db, credentialService }));
  app.use('/api/temporal', temporalRouter({ temporalBridge }));
  app.use('/api/worker', workerRouter({ workerService }));
  app.use('/api/nginx', nginxRouter({ infraService, nginxConfPath: NGINX_CONF_PATH }));
  app.use('/api/logs', logsRouter({ db, clusterService, appService }));
  app.use('/api/registry', registryRouter({ registryService }));
  app.use('/api/modules', modulesRouter({ gitModuleService }));
  app.use('/api/app-schemas', appSchemasRouter({}));

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
    include: ['draft', 'approved'],
  });

  const draftCatalogue = createStoredToolCatalogue({
    tools: { list: (ownerId?: string) => db.getEngineTools(ownerId) },
    include: ['draft', 'approved'],
  });

  const evalWeb = await buildWebTools(db).catch(() => undefined);
  const evalHost = createEngineHost({
    models: modelService,
    stores: storesFromDatabase(db),
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

  const level1Service = new Level1Service({
    executor: createProcedureExecutor(evalHost.services, { registry: evalHost.registry }),
    tools: (ownerId: string) => draftCatalogue.list(ownerId),
    agents: async (ownerId: string) => (await draftRegistry.agents(ownerId)).map((agent) => agent.slug),
    store: db,
    provokedByScenarios: (ownerId: string) => level2Service.provocations(ownerId),
    efforts: (effort) => db.saveRunEffort(effort),
  });

  const level2Service: Level2Service = new Level2Service({
    world: {
      models: modelService,
      personas: (ownerId?: string) => db.getEnginePersonas(ownerId),
      tools: (ownerId?: string) => db.getEngineTools(ownerId),
      procedures: (ownerId?: string) => db.getProcedures(ownerId),
      ...(evalWeb ? { web: evalWeb } : {}),
      kubeconfig: process.env.KUBECONFIG_PATH,
      registryHost: process.env.KOALA_REGISTRY,
      efforts: { save: (effort) => db.saveRunEffort(effort), list: (ownerId, procedureId, modelKey) => db.getRunEffort(ownerId, procedureId, modelKey) },
    },
    tools: (ownerId: string) => draftCatalogue.list(ownerId),
    agents: async (ownerId: string) => (await draftRegistry.agents(ownerId)).map((agent) => agent.slug),
    procedures: async (ownerId: string) => (await engineRegistry.procedures(ownerId)).map((procedure) => procedure.id),
    store: db,
    traces: (traces) => db.saveRunTraces(traces),
  });

  await Promise.all([level1Service.recover(), level2Service.recover()]).catch(() => undefined);

  void evalHost.workspaceImages.warm().then((images) => {
    const building = images.filter((image) => image.state === 'building');
    const failed = images.filter((image) => image.state === 'failed');
    if (building.length > 0) console.log(`[images] building ${building.length} workspace ${building.length === 1 ? 'image' : 'images'} ahead of the first run`);
    for (const image of failed) console.warn(`[images] ${image.agent}: ${image.detail ?? 'the image could not be built'}`);
  }).catch((err: Error) => console.warn(`[images] could not warm workspace images: ${err.message}`));

  app.use('/api/procedures', proceduresRouter({
    procedures: new ProcedureService({
      procedures: createProcedureStore({ sources: { list: (ownerId?: string) => db.getProcedures(ownerId) } }),
      sources: {
        get: (ownerId, id) => db.getProcedure(ownerId, id),
        save: (source) => db.saveProcedure(source),
        delete: (ownerId, id) => db.deleteProcedure(ownerId, id),
      },
      known: async (ownerId) => ({
        tools: new Set((await engineRegistry.tools(ownerId)).map((tool) => tool.name)),
        agents: new Set((await engineRegistry.agents(ownerId)).map((agent) => agent.slug)),
      }),
      effort: { list: (ownerId, procedureId) => db.getRunEffort(ownerId, procedureId) },
    }),
  }));

  app.use('/api/engine', engineRouter({
    runs: engineRuns,
    registry: engineRegistry,
    traces: { list: (ownerId: string, runId: string) => db.getRunTraces(ownerId, runId) },
    tasks: {
      list: (ownerId: string) => db.getTasks(ownerId),
      save: (task) => db.saveTask(task),
    },
  }));

  app.use('/api/engine-tools', engineToolsRouter({
    tools: new EngineToolService({
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

  app.use('/api/agents', agentsRouter({
    agents: new AgentService({
      personas: {
        list: (ownerId?: string) => db.getEnginePersonas(ownerId),
        save: (persona) => db.saveEnginePersona(persona),
        remove: (ownerId, slug) => db.deleteEnginePersona(ownerId, slug),
      },
      tools: (ownerId: string) => draftCatalogue.list(ownerId),
      procedures: (ownerId: string) => engineRegistry.procedures(ownerId),
      images: evalHost.images,
    }),
  }));

  app.use('/api/evals/level1', evalsLevel1Router({ level1: level1Service }));
  app.use('/api/evals/level2', evalsLevel2Router({ level2: level2Service }));

  app.use('/api/conversations', conversationsRouter({
    db,
    ownedConversations,
    ownedTrees,
    ownedProjects: async (userId: string) => (await db.getProjects()).filter((project) => project.ownerId === userId),
  }));

  app.use('/api/memories', memoriesRouter({ db, temporalBridge }));

  app.use('/api/tree-types', treeTypesRouter({ db }));
  app.use('/api/binding-types', bindingTypesRouter({ db }));
  const groveRuns = new GroveRunService({ store: db, launcher: temporalBridge });
  const groveDeletion = new GroveDeletionService({
    store: db,
    workflows: { terminate: (workflowId, reason) => temporalBridge.terminateIfRunning(workflowId, reason) },
    workspaces: evalHost.treeWorkspaces,
  });
  app.use('/api/trees', treesRouter({ db, workspaces: evalHost.treeWorkspaces, runs: groveRuns, deletion: groveDeletion }));
  app.use('/api/plans', plansRouter({ plans: new PlanService({ store: db, adopter: temporalBridge }) }));
  app.use('/api/secret-requests', secretRequestsRouter({ secrets: new SecretRequestService({ store: db, vault: infisicalService }) }));
  app.use('/api/branches', branchesRouter({ db, deletion: groveDeletion }));

  async function koalaServers(userId: string) {
    try {
      const registry = new McpRegistryService(db, userId, (n: string) => resolveMcpProbeUrl(n));
      return preferUsable(await registry.listWithTools());
    } catch (err: any) {
      console.warn(`[koala] could not list services: ${err.message}`);
      return [];
    }
  }

  app.use('/api/leaves', leavesRouter({ db, runs: groveRuns, deletion: groveDeletion }));

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
