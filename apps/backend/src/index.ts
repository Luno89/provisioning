import { getModelRateLimiterSnapshot } from '@koala/agent-engine';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { Server as SocketServer } from 'socket.io';

import { authRouter } from './accounts/routes/auth.js';
import helmet from 'helmet';
import {
  CSP_REPORT_PATH, cspHeader, cspModeFrom, violationLine, MetricsService, RATE_LIMITS, ruleFor,
  getTemporalClient, resolveOwnersWith, PayloadStorageService, createAuth, keepTrying, mongoTarget, asyncRoute,
  ownsProject, createDatabase, sharedPayloadBlobs, type Database, migrateLegacyOwnership, decryptValue, loadKeys,
  roleFromEnv, servesTenants, holdsAccounts, MailService, emailWayFrom,
} from './platform/index.js';
import { rateLimit } from 'express-rate-limit';
import { wireReleases } from './releases/wiring/releases.js';
import { storyDropsFor, wireFiles } from './files/wiring/files.js';
import { wireMachines } from './machines/wiring/machines.js';
import { wireMonitoring } from './monitoring/wiring/monitoring.js';
import { wireInfrastructure } from './infrastructure/wiring/infrastructure.js';
import { wireAccounts } from './accounts/wiring/accounts.js';
import { hubInstanceWork, wireHub } from './hub/wiring/hub.js';
import { InstanceSide, wireInstances, wireMoveExport } from './instances/wiring/instances.js';
import { projectsCore, wireProjects } from './projects/wiring/projects.js';
import { engineCore, wireEngine, startEngineStream } from './engine/wiring/engine.js';
import { wireSockets } from './machines/wiring/sockets.js';
import { workFailuresFor, wireRunning } from './infrastructure/wiring/running.js';
import { wireActions } from './engine/wiring/actions.js';
import { PRUNE_FIRST_DELAY_MS, PRUNE_INTERVAL_MS } from './engine-host/sandboxes/prune-images.js';
import { askDevice, localAgentStatus, tellDevice, MachineService } from './machines/index.js';
import { RootMeshKeys } from './instances/services/RootMeshKeys.js';
import { modelsRouter } from './models/routes/models.js';

import {
  InfrastructureService, ClusterService, AppService, RegistryService, GitModuleService, BuilderService,
  AppExposureService, VpsCatalogService, WorkerService, sharedClusterProxy, CredentialService, InfisicalService,
  HeadscaleService,
} from './infrastructure/index.js';
import { TemporalBridge } from './infrastructure/services/TemporalBridge.js';
import net from 'net';
import { spawn } from 'child_process';
import { AuthService } from './accounts/services/AuthService.js';
import { GiteaService } from './projects/index.js';
import { ModelService } from './models/services/ModelService.js';

import { seedAll } from './scripts/seed-all.js';
import { endpointRulesFromEnv } from './models/lib/endpoint-url-safety.js';
import { IdentityService } from './instances/services/IdentityService.js';
import { NotificationService } from './monitoring/index.js';
import { artifactsRouter, createArtifactService } from './files/index.js';

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
  resolveOwnersWith(async (owner) => (await db.accounts.getUserById(owner))?.space?.person ?? owner);
  await migrateLegacyOwnership(db);
  await seedAll(db);

  const keys = loadKeys(process.env);
  const role = roleFromEnv(process.env);
  const metrics = new MetricsService({ token: process.env.METRICS_TOKEN?.trim() || undefined, role: role.role });
  const mail = new MailService({
    way: emailWayFrom(process.env, role),
    emailOf: async (ownerId) => (await db.accounts.getUserById(ownerId))?.email,
  });
  const notifications = new NotificationService({ store: db.monitoring, mail, publicUrl: PUBLIC_URL, log: (message) => console.warn(message) });
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
  const instanceSide = new InstanceSide(role, process.env);
  const appExposureService = new AppExposureService(db, infraService, clusterService, io, {
    edge: instanceSide.edge,
    groupOf: async (dep) => (dep.gitappProjectId ? (await db.hub.getHubLinks()).find((link) => link.projectId === dep.gitappProjectId)?.group : undefined),
  });
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
  const core = projectsCore({ db, io, env: process.env, dataKey: keys.data, gitea: giteaService, infra: infraService, infisical: infisicalService, kubeconfig: '/tmp/kubeconfig-provisioning-lunorica' });
  const { projectRepoService, channels, itemChats, notices, postNotice, projectSecrets } = core;
  const headscaleService = new HeadscaleService(keys.data, process.env.HEADSCALE_URL || 'http://localhost:8080');
  const machineService = new MachineService({
    store: db.machines,
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

  const engine = engineCore({ db, env: process.env, temporalBridge, machines: machineService, checks: () => level2Service });
  const {
    extensions, agentDirectory, engineRegistry, engineRuns, workspaceBuilds, workspaceRepos, workspaceConclusions,
    memoryKeeper, concluded, runningRecords, bench, agentsHolder, workspaceDependencies,
  } = engine;
  const workFailures = workFailuresFor({ db, temporalBridge, metrics, records: runningRecords });

  startEngineStream({ role, io, db, payloadKey: keys.payload, core: engine, models: modelService, notices, postNotice, workFailures });

  const authService = new AuthService(db);
  app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
  app.use(cors({
    origin: (origin, callback) => callback(null, originAllowed(origin)),
    credentials: true,
  }));

  tenant.post('/webhooks/gitea/:projectId', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      const projects = await db.projects.getProjects();
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
  const csp = cspHeader(cspModeFrom(process.env));
  if (csp) app.use((_req, res, next) => { res.setHeader(csp.name, csp.value); next(); });
  app.post(CSP_REPORT_PATH, express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '64kb' }), (req, res) => {
    const line = violationLine(req.body);
    if (line) console.warn(`[csp] ${line}`);
    res.status(204).end();
  });
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
  const { requireAdmin } = auth;

  let runningNow: (() => Promise<string[] | 'unknown'>) | undefined;
  await wireMoveExport({
    role, env: process.env, app, dataDir: path.join(__dirname, '../data'), mongo: mongoTarget(process.env),
    running: async () => (runningNow ? runningNow() : 'unknown'),
  });

  app.use('/api', auth.requireAuth);
  app.get('/api/metrics', asyncRoute(async (req, res) => {
    if (!metrics.allowed(req.headers.authorization)) return res.status(401).json({ error: 'metrics are read with the METRICS_TOKEN' });
    res.type(metrics.contentType).send(await metrics.text());
  }));

  wireSockets({ io, db, role, env: process.env, payloadKey: keys.payload, dataKey: keys.data, auth, machines: machineService, clusters: clusterService, apps: appService, infra: infraService });

  app.use('/api/auth', authRouter({
    db, authService, auth, sessionKey: keys.session, publicUrl: PUBLIC_URL, appUrl: APP_URL, accounts: holdsAccounts(role), hub: role.role === 'hub',
  }));
  const hub = await wireHub({
    role, env: process.env, app, tenant, db, mail, publicUrl: PUBLIC_URL, dataKey: keys.data, gitea: giteaService,
    notify: (ownerId, scope, notice) => notices.post(ownerId, scope, notice),
    republish: () => appExposureService.syncExposedApps(),
  });

  tenant.get('/ingress/verify', async (req, res) => {
    const domain = String(req.query.domain ?? '');
    if (!domain) return res.status(400).send('domain required');
    const deployments = await db.infrastructure.getDeployments();
    const owned = deployments.some((d) => d.isExposedPublicly && d.publicHostname === domain);
    return owned ? res.status(200).send('ok') : res.status(404).send('unknown host');
  });

  await wireInstances({
    role, env: process.env, app, tenant, db, mail, identity, auth, sessionKey: keys.session, publicUrl: PUBLIC_URL,
    repoRoot: path.join(__dirname, '../../..'), dataDir: path.join(__dirname, '../data'), headscale: headscaleService, infra: infraService,
    side: instanceSide, syncExposedApps: () => appExposureService.syncExposedApps(),
  });
  const systemOwners = async (): Promise<string[]> => (role.instance
    ? [role.instance.ownerId]
    : (await db.accounts.getUsers()).filter((user) => user.isAdmin).map((user) => user.id));
  const { monitoring } = wireMonitoring({ tenant, db, role, env: process.env, io, clusters: clusterService, infra: infraService, proxy: clusterProxyService, notices, notifications, mail, systemOwners });
  const workerService = new WorkerService();
  wireInfrastructure({
    tenant, db, io, dataKey: keys.data, publicUrl: PUBLIC_URL, appUrl: APP_URL, repoRoot: path.join(__dirname, '../../..'),
    credentials: credentialService, clusters: clusterService, apps: appService, proxy: clusterProxyService, infra: infraService,
    temporalBridge, gitea: giteaService, infisical: infisicalService, exposure: appExposureService, instanceOwner: role.instance?.ownerId,
    nginxConfPath: path.join(__dirname, '../data/nginx/nginx.conf'), vpsCatalog: vpsCatalogService, worker: workerService, registry: registryService, gitModules: gitModuleService,
  });

  const getOwnedProject = async (id: string, user: any): Promise<any | undefined> => {
    const project = (await db.projects.getProjects()).find((p: any) => p.id === id);
    return project && ownsProject(project, user) ? project : undefined;
  };

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
  wireAccounts({ app, role, env: process.env, db, temporalBridge, hubPeople: hub.hubPeople, requireAdmin, clearSession: (res) => res.clearCookie('session', auth.sessionCookieOptions) });
  tenant.use('/api/models', modelsRouter({ modelService, db, credentialService, machines: machineService, rateLimits: getModelRateLimiterSnapshot }));

  const { evalHost, level2Service, procedureService, mcpCatalogue } = await wireEngine({
    tenant, db, io, env: process.env, role, sessionKey: keys.session, dataKey: keys.data, core: engine, temporalBridge, models: modelService, gitea: giteaService,
    artifacts: artifactStore, projectRepos: projectRepoService, customizations, releaseSettings, treeModels: () => treeModels, requireAdmin,
  });
  if (evalHost.storyDrops) files.setStoryDrops(storyDropsFor({ db, projectRepos: projectRepoService, gitea: giteaService, work: evalHost.storyDrops }));
  if (servesTenants(role)) void db.accounts.getUsers().then((users) => odooReleases.recover(users.map((user) => user.id))).catch(() => undefined);
  if (servesTenants(role)) void releases.letReleasesPull().catch((err: Error) => console.warn(`[releases] could not give release namespaces their registry login: ${err.message}`));

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
  }

  const { treeModels, groveRuns, groveOrder, planService } = wireProjects({
    tenant, db, io, env: process.env, dataKey: keys.data, core, gitea: giteaService, infra: infraService, clusters: clusterService, apps: appService,
    temporalBridge, models: modelService, machines: machineService, registry: engineRegistry, runs: engineRuns, extensions, evalHost,
    workspaceBuilds, workspaceConclusions, workspaceRepos, concluded, sharing: () => hub.sharingService, getOwnedProject,
  });
  const { running } = wireRunning({
    tenant, db, role, temporalBridge, monitoring, workFailures, records: runningRecords, checks: level2Service, trees: groveRuns, runs: engineRuns,
    bench, keeper: memoryKeeper, infra: infraService, clusters: clusterService,
  });
  runningNow = async () => {
    const view = await running.view(role.instance?.ownerId ?? '');
    if (!view.ok) return 'unknown';
    return view.value.items.map((item) => item.title);
  };
  if (hub.reaches) {
    hub.setWork(hubInstanceWork({
      db, releases: odooReleases, treeRuns: groveRuns, plans: planService, order: groveOrder, accepted: evalHost.acceptedNeeds,
      itemChats, runs: engineRuns, procedures: procedureService, extensions, files: files.fileService,
    }));
  }

  wireActions({
    tenant, db, env: process.env, egressKey: keys.egress, kubeconfig: '/tmp/kubeconfig-provisioning-lunorica', temporalBridge, monitoring, releaseSettings,
    treeModels, mcpCatalogue, workspaceDependencies, agentDirectory, agentsHolder, concluded, infra: infraService, infisical: infisicalService,
  });

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
