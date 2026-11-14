import { QUEUES } from './platform/index.js';
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

import { authRouter, AuthService, devicesFor, loadBreachedPasswords, passwordRouter, PasswordService, SignInProviders } from './accounts/index.js';
import helmet from 'helmet';
import { CSP_REPORT_LIMIT, CSP_REPORT_PATH, cspHeader, violationLine, crossSiteRefusal, foreignOrigin, MetricsService, JSON_LIMITS, jsonLimitFor, RATE_LIMITS, ruleFor,
  getTemporalClient, resolveOwnersWith, PayloadStorageService, createAuth, inFlightLimit, keepTrying, asyncRoute, errorResponder,
  TEMPORAL_JWKS_PATH, temporalCa, temporalTlsProblem, temporalKeysRouter,
  authorize, claimSettingsFrom, type Principal, createDatabase, sharedPayloadBlobs, type Database, migrateLegacyOwnership, operatorsFromAdmins, ownUnownedProjects, decryptValue,
  AccessRevocations, SessionEnds, SessionSockets, endsSessions, servesTenants, holdsAccounts, MailService, telemetrySettings, firstAdminSetup, inClusterSlices, runOnce,
  backendSettingsFrom, connectTemporalAs, isOff, keepPayloadsIn, MACHINE_GATEWAY_HOST, SettingsError, signsEveryoneIn, type BackendSettings } from './platform/index.js';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { checkServices, collectorAnswers, dependencyStatesFor, reportCollectorTo } from './platform/wiring/dependencies.js';
import { rateLimit } from 'express-rate-limit';
import { wireReleases } from './releases/wiring/releases.js';
import { archiveOldFilesOnce, keepStoredFilesSwept, storedFilesFor, storyDropsFor, wireFiles } from './files/wiring/files.js';
import { machineBundle as newMachineBundle, wireMachines } from './machines/wiring/machines.js';
import { wireMonitoring } from './monitoring/wiring/monitoring.js';
import { wireInfrastructure } from './infrastructure/wiring/infrastructure.js';
import { wireAccounts } from './accounts/wiring/accounts.js';
import { hubInstanceWork, wireHub } from './hub/wiring/hub.js';
import { InstanceSide, wireInstances, wireMoveExport } from './instances/wiring/instances.js';
import { rootProviderFor, rootSignInFor } from './instances/wiring/sign-in.js';
import { projectsCore, wireProjects } from './projects/wiring/projects.js';
import { engineCore, wireEngine, startEngineStream } from './engine/wiring/engine.js';
import { wireSockets } from './machines/wiring/sockets.js';
import { workFailuresFor, wireRunning } from './infrastructure/wiring/running.js';
import { wireActions } from './engine/wiring/actions.js';
import { PRUNE_FIRST_DELAY_MS, PRUNE_INTERVAL_MS } from './engine-host/sandboxes/prune-images.js';
import { onKoalasCluster } from './engine-host/sandboxes/kube.js';
import { runClosedVia, runLifeVia } from './engine-host/temporal/run-cancellation.js';
import { askDevice, dropDevice, localAgentStatus, tellDevice, machineTelemetry } from './machines/index.js';
import { machineSides } from './machines/wiring/sides.js';
import { IdentityService, InstanceReach } from './instances/index.js';
import { chatTemplatesOverHttp, modelsRouter, ModelService, servedWindowsOverHttp, ToolCallParsers, toolCallParsersRouter } from './models/index.js';

import {
  InfrastructureService, ClusterService, clusterAccessFrom, AppService, RegistryService, GitModuleService, BuilderService,
  AppExposureService, VpsCatalogService, WorkerService, sharedClusterProxy, CredentialService, InfisicalService,
  HeadscaleService, BUILD_TOKENS_MIGRATION, cleanUpBuildTokens, pullSecretWriter, ovhSubsidiaryOf, terraformPlacesFor, vpsCatalogAdapters,
  savedHuggingFaceTokenOf,
} from './infrastructure/index.js';
import { TemporalBridge } from './infrastructure/services/TemporalBridge.js';
import { GiteaService, pushToBuild } from './projects/index.js';
import { HUB_REPO_HOOK_PATH, hubRepoHookSecret, hubRepoHookSecrets, hubRepoHookUrl } from './hub/index.js';

import { seedAll } from './scripts/seed-all.js';
import { collectorEndpoint, collectorSink, NotificationService, PushService, vapidKeysFrom, vapidSubject, webPushSend } from './monitoring/index.js';
import { holdFences } from './platform/wiring/fences.js';
import { stopBackend } from './platform/wiring/shutdown.js';

const startsHere = process.env.NODE_ENV !== 'test' || process.env.IS_E2E === 'true';
if (startsHere) dotenv.config({ quiet: true });

export async function bootstrap(): Promise<{ app: express.Application; io: SocketServer; temporalBridge?: TemporalBridge; db: Database; settings: BackendSettings }> {
  const settings = backendSettingsFrom(process.env);
  const telemetry = startTelemetry(telemetrySettings(settings, 'koala-backend'));
  const dependencies = dependencyStatesFor(settings, { where: settings.role.instance ? { root: settings.role.instance.rootUrl } : {} });
  reportCollectorTo(telemetry, dependencies);
  const plaintext = temporalTlsProblem(settings.temporal);
  if (plaintext) throw new Error(plaintext);
  connectTemporalAs(settings);
  keepPayloadsIn(settings.mongo);
  const app = express();
  const httpServer = createServer(app);
  httpServer.requestTimeout = 0;
  const { port, production } = settings;

  const PUBLIC_URL = settings.publicUrl;

  const APP_URL = settings.appUrl;

  const corsAllowed = new Set([PUBLIC_URL, APP_URL]);
  const originAllowed = (origin: string | undefined): boolean =>
    !origin || !production || corsAllowed.has(origin.replace(/\/$/, ''));

  const ours = settings.origins;
  const io = new SocketServer(httpServer, {
    allowRequest: (req, callback) => {
      const refused = foreignOrigin({ host: req.headers.host, origin: req.headers.origin, fetchSite: req.headers['sec-fetch-site'] as string | undefined }, ours);
      callback(refused ?? null, !refused);
    },
    cors: {
      origin: (origin, cb) => cb(null, originAllowed(origin)),
      credentials: true,
    },
  });

  const keys = settings.keys;
  const db = createDatabase({ mongo: settings.mongo, dataKey: keys.data });
  db.reportReachTo(dependencies);
  dependencies.checkWith('mongo', () => db.ping());
  await db.init();
  const fences = await holdFences('backend', db.platform);
  resolveOwnersWith(async (owner) => (await db.accounts.getUserById(owner))?.space?.person ?? owner);
  const { role } = settings;
  const claimSettings = claimSettingsFrom(role);
  await operatorsFromAdmins(db, new Date().toISOString());
  await migrateLegacyOwnership(db, claimSettings);
  await runOnce(db.platform, 'projects-owned', new Date().toISOString(), () => ownUnownedProjects(db, claimSettings));
  await seedAll(db, keys.data);

  const revocations = new AccessRevocations();
  const instanceReach = new InstanceReach(settings.reach);
  const rootProvider = rootProviderFor({ role, publicUrl: PUBLIC_URL, keys, db, proxied: production, reach: instanceReach });
  if (rootProvider) revocations.listen((revoked) => rootProvider.revoke(revoked));
  const rootSignIn = rootSignInFor({ role, instanceCredential: settings.instance?.credential, keys, db, revocations, publicUrl: PUBLIC_URL });
  const rootToken = rootSignIn ? () => rootSignIn.serviceToken() : undefined;
  const metrics = new MetricsService({ token: isOff(settings.metricsToken) ? undefined : settings.metricsToken, role: role.role });
  const mail = new MailService({
    way: settings.mail,
    emailOf: async (ownerId) => (await db.accounts.getUserById(ownerId))?.email,
    rootToken,
  });
  const vapid = vapidKeysFrom(typeof keys.data === 'string' ? keys.data : keys.data.current);
  const push = new PushService({ store: db.monitoring, vapid, send: webPushSend(vapid, vapidSubject(settings.mail.kind === 'smtp' ? settings.mail.from : undefined, PUBLIC_URL)), log: (message) => console.warn(message) });
  const notifications = new NotificationService({ store: db.monitoring, mail, push, publicUrl: PUBLIC_URL, log: (message) => console.warn(message) });
  const tenants = servesTenants(role);
  const engineTaskQueue = QUEUES.engine;
  const tenantServices = settings.tenant;
  const instanceFiles = tenantServices ? storedFilesFor({ db, minio: tenantServices.minio, workflows: async () => (await getTemporalClient()).workflow, engineTaskQueue, dataDir: settings.dataDir, dependencies }) : undefined;
  const tenant: express.Router = tenants ? (app as unknown as express.Router) : express.Router();
  const identity = new IdentityService(role, db, undefined, undefined, instanceReach);
  console.log(`🧭 Running as ${role.role}${role.instance ? ` (instance ${role.instance.id}, owned by ${role.instance.ownerId})` : ''}`);
  const infraService = new InfrastructureService(terraformPlacesFor(settings.terraform, settings.dataDir));
  const builderService = new BuilderService(db, infraService);
  const clusterAccess = clusterAccessFrom(settings.clusters, { role: role.role, clusters: db.infrastructure, dataKey: keys.data });
  const koalasCluster = (): string => clusterAccess.own().clusterId;
  const clusterService = new ClusterService(db, clusterAccess, { instanceOwnerId: role.instance?.ownerId });
  const appService = new AppService(db, infraService, clusterService, builderService);
  const registryService = new RegistryService(db);
  const gitModuleService = new GitModuleService(db);
  const instanceSide = new InstanceSide(role, { edge: settings.instance?.edge ?? { off: `${role.role} runs no edge; an instance does` }, unreachableAfterMs: settings.tests.unreachableAfterMs }, rootToken);
  instanceSide.watchRoot((ownerId, message) => push.toPerson(ownerId, message), dependencies);
  const appExposureService = new AppExposureService(db, clusterService, io, {
    edge: instanceSide.edge,
    groupOf: async (dep) => (dep.gitappProjectId ? (await db.hub.getHubLinks()).find((link) => link.projectId === dep.gitappProjectId)?.group : undefined),
    domain: () => (isOff(settings.ingressDomain) ? undefined : settings.ingressDomain),
  });
  const clusterProxyService = sharedClusterProxy(clusterAccess);
  const telemetrySink = collectorSink({
    otlpEndpoint: settings.telemetry.otlpEndpoint,
    proxy: clusterProxyService,
    koalasCluster,
  });
  telemetry.exportTo(telemetrySink);
  dependencies.checkWith('collector', collectorAnswers(settings.telemetry.otlpEndpoint ? () => settings.telemetry.otlpEndpoint : collectorEndpoint({ proxy: clusterProxyService, koalasCluster })));
  const gitea = tenantServices?.gitea ?? settings.hubGitea;
  const giteaService = new GiteaService(keys.data, gitea ?? { none: `${role.role} keeps no repositories, so it reaches no Gitea` }, { dataDir: settings.dataDir, registryPullHost: tenantServices?.registryPullHost, reportsTo: dependencies });
  const infisicalService = new InfisicalService(keys.data, tenantServices ? tenantServices.infisical : { none: `${role.role} keeps no project's secrets, so it reaches no Infisical` }, settings.dataDir, dependencies);
  checkServices(dependencies, {
    gitea: gitea?.url,
    infisical: tenantServices?.infisical.url,
    minio: tenantServices?.minio,
    registryPush: tenantServices?.registry.push,
    webTools: tenantServices?.webTools,
  });
  const core = projectsCore({ db, push, io, here: settings.clusters.here, dataKey: keys.data, gitea: giteaService, webhooksTo: tenants ? gitea?.reachesKoalaAt : undefined, infisical: infisicalService });
  const { projectRepoService, channels, itemChats, notices, postNotice, projectSecrets } = core;
  const headscaleService = new HeadscaleService(keys.data, settings.mesh, settings.dataDir);
  const machineTemporalAddress = settings.instance?.machineTemporalAddress;
  const machineTemporal = typeof machineTemporalAddress === 'string' ? { address: machineTemporalAddress, namespace: settings.temporal.namespace } : undefined;
  if (machineTemporalAddress && isOff(machineTemporalAddress)) console.warn(`[machines] ${machineTemporalAddress.off}`);
  const machineBundle = newMachineBundle(path.join(__dirname, '../../..'), settings.dataDir);
  const late: { instances?: Awaited<ReturnType<typeof wireInstances>> } = {};
  const { accounts: machineAccounts, machines: machineService, clusters: machineClusters, workTokens, instanceArrived, instanceCaller } = machineSides({
    role, db, io, dataKey: keys.data, publicUrl: PUBLIC_URL, meshLoginServer: isOff(settings.mesh) ? undefined : settings.mesh.loginServer, registry: settings.root?.registry, koalaMachineId: settings.clusters.here.koalaMachineId, mesh: headscaleService,
    devices: { status: localAgentStatus, tell: tellDevice, ask: askDevice, drop: dropDevice },
    projects: projectRepoService, bundle: machineBundle, rootToken,
    side: instanceSide,
    instances: () => (late.instances ? { service: late.instances.instanceService, tellInstance: late.instances.tellInstance } : undefined),
  });
  const modelService = new ModelService(db, appService, clusterService, clusterProxyService, headscaleService, servedWindowsOverHttp(), keys.data, settings.endpointRules);

  const toolCallParsers = new ToolCallParsers({ store: db.models, templates: chatTemplatesOverHttp(settings.tests.huggingFaceUrl), savedToken: savedHuggingFaceTokenOf(db.accounts, keys.data) });
  const temporalBridge = new TemporalBridge(db, path.join(settings.dataDir, 'logs'), io, keys.data, clusterService, { dependencies, toolCalling: toolCallParsers });
  appService.setTemporalBridge(temporalBridge);
  if (tenants) {
    await keepTrying('⚠️ Temporal is not connected yet, so work that needs it is refused until it is', async () => {
      await temporalBridge.start();
      await temporalBridge.startActiveWorkflowRecovery();
    }, (message) => console.warn(message));
  }

  const engine = engineCore({ db, role, temporalBridge, machines: machineService, checks: () => level2Service, revocations });
  const {
    extensions, agentDirectory, engineRegistry, engineRuns, workspaceBuilds, workspaceRepos, workspaceConclusions,
    memoryKeeper, concluded, runningRecords, bench, agentsHolder, workspaceDependencies,
  } = engine;
  const workFailures = workFailuresFor({ db, temporalBridge, metrics, records: runningRecords });

  startEngineStream({ role, push, io, db, connection: settings, core: engine, models: modelService, notices, postNotice, workFailures, machineClusters, storedFiles: instanceFiles?.activities, dependencies });
  if (instanceFiles) keepStoredFilesSwept({ workflows: async () => (await getTemporalClient()).workflow, engineTaskQueue });
  if (instanceFiles && !settings.underTest) archiveOldFilesOnce({ db, storedFiles: instanceFiles.storedFiles, clusters: clusterService });

  const authService = new AuthService(db, { mail, production, push, ...(isOff(settings.twilio) ? {} : { twilio: settings.twilio }) });
  const passwords = new PasswordService({ db, auth: authService, breached: loadBreachedPasswords(), revocations });
  const sessionEnds = new SessionEnds(db.platform);
  await sessionEnds.follow();
  const sessionSockets = new SessionSockets();
  sessionEnds.onEnd((sessionId) => sessionSockets.end({ kind: 'session', sessionId }));
  revocations.listen(async (revoked) => { if (endsSessions(revoked)) sessionSockets.end({ kind: 'person', personId: revoked.personId, before: Date.parse(revoked.at) }); });
  app.set('trust proxy', settings.trustProxy);
  app.use(inFlightLimit());
  app.use(cors({
    origin: (origin, callback) => callback(null, originAllowed(origin)),
    credentials: true,
  }));

  tenant.post('/webhooks/gitea/:projectId', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
    try {
      const projects = await db.projects.getProjects();
      const project = projects.find((p) => p.id === req.params.projectId);
      if (!project) return res.status(404).json({ error: 'Unknown project' });
      if (project.removal) return res.status(410).json({ error: 'This project is being deleted' });
      if (!project.webhookSecretEnc) return res.status(500).json({ error: 'Project has no webhook secret configured' });

      const secret = decryptValue(project.webhookSecretEnc, keys.data);
      const rawBody = req.body as Buffer;
      if (!giteaService.verifyWebhookSignature(rawBody, req.header('X-Gitea-Signature'), secret)) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }

      void hub.repoPushed(project.id).catch((err: Error) => console.warn(`[webhook] the hub was not told ${project.id}'s repository moved: ${err.message}`));
      const decided = pushToBuild(JSON.parse(rawBody.toString('utf8')));
      if ('ignored' in decided) return res.status(200).json({ status: 'ignored', reason: decided.ignored });
      const payload = decided.build;

      res.status(202).json({ status: 'accepted' });
      temporalBridge.runPipeline(project, payload.after, payload.ref).catch((err: Error) =>
        console.error(`[webhook] Failed to start pipeline run for project ${project.id}: ${err.message}`)
      );
      workspaceBuilds.pushed(project, payload.after, payload.commits).catch((err: Error) =>
        console.error(`[webhook] Failed to start the workspace build for project ${project.id}: ${err.message}`)
      );
    } catch (err) {
      console.error(`[webhook] Gitea webhook error: ${(err as Error).message}`);
      res.status(500).json({ error: 'Internal error processing webhook' });
    }
  }));

  app.post(`${HUB_REPO_HOOK_PATH}/:projectId`, express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
    const projectId = String(req.params.projectId);
    const signature = req.header('X-Gitea-Signature');
    if (!hubRepoHookSecrets(keys.data, projectId).some((secret) => giteaService.verifyWebhookSignature(req.body as Buffer, signature, secret))) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    const told = hub.hubService ? await hub.hubService.repoMoved(projectId) : false;
    return told ? res.status(202).json({ status: 'accepted' }) : res.status(404).json({ error: 'Unknown shared project' });
  }));

  app.use(metrics.middleware());
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, hsts: production }));
  app.use(TEMPORAL_JWKS_PATH, temporalKeysRouter({ temporalKey: keys.temporal }));
  const csp = cspHeader(settings.csp);
  if (csp) app.use((_req, res, next) => { res.setHeader(csp.name, csp.value); next(); });
  app.post(CSP_REPORT_PATH, rateLimit({ windowMs: CSP_REPORT_LIMIT.windowMs, limit: CSP_REPORT_LIMIT.max, standardHeaders: 'draft-8', legacyHeaders: false, message: '' }), express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '64kb' }), (req, res) => {
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
    skipSuccessfulRequests: rule.countsOnlyFailures,
    skip: (req) => ruleFor(req.path)?.name !== rule.name,
  })));
  app.use('/api', (req, res, next) => {
    const refused = crossSiteRefusal(req.method, { host: req.headers.host, origin: req.headers.origin, fetchSite: req.get('sec-fetch-site') }, ours);
    if (refused) return res.status(403).json({ error: `Refused: ${refused}` });
    next();
  });
  const credentialService = new CredentialService(db, keys.data, { claims: claimSettings, credentials: settings.operator });
  const vpsCatalogService = new VpsCatalogService(vpsCatalogAdapters(() => ovhSubsidiaryOf(settings.operator.ovhSubsidiary)));

  const setup = settings.root ? firstAdminSetup({ setupCode: settings.root.setupCode, production }, (await db.accounts.getUsers()).length === 0) : undefined;
  if (setup?.say) console.log(`🔑 ${setup.say}`);
  const auth = createAuth({ db, sessionKey: keys.session, publicUrl: PUBLIC_URL, role: role.role, instanceOwnerId: claimSettings.instanceOwnerId, setupCode: setup?.code, clientSessions: rootSignIn, sessionEnds, signsEveryoneIn: signsEveryoneIn(settings) });
  const devices = devicesFor({ auth, sessionKey: keys.session, authService });
  const { requireOperator } = auth;

  let runningNow: (() => Promise<string[] | 'unknown'>) | undefined;
  await wireMoveExport({
    role, pool: Boolean(settings.clusters.here.poolName), moved: settings.instance?.move, app, dataDir: settings.dataDir, mongo: settings.mongo, access: clusterService.access,
    running: async () => (runningNow ? runningNow() : 'unknown'),
    claim: (jti, expiresAt) => db.instances.claimHandoff(jti, expiresAt),
  });

  app.use('/api', auth.requireAuth);
  const jsonParsers = { signedIn: express.json({ limit: JSON_LIMITS.signedIn }), signedOut: express.json({ limit: JSON_LIMITS.signedOut }) };
  app.use((req, res, next) => jsonParsers[jsonLimitFor(req.path, Boolean((req as { user?: unknown }).user))](req, res, next));
  app.get('/api/metrics', asyncRoute(async (req, res) => {
    if (!metrics.allowed(req.headers.authorization)) return res.status(401).json({ error: 'metrics are read with the METRICS_TOKEN' });
    res.type(metrics.contentType).send(await metrics.text());
  }));

  wireSockets({ io, db, role, signsEveryoneIn: signsEveryoneIn(settings), payloadBlobs: sharedPayloadBlobs(), sessionSockets, payloadKey: keys.payload, dataKey: keys.data, auth, machines: machineService, workTokens, machineClusters, clusters: clusterService, apps: appService, telemetry: machineTelemetry({ sink: () => telemetrySink }), machineTemporal, runs: { life: runLifeVia(() => getTemporalClient(), dependencies), closed: runClosedVia(() => getTemporalClient(), dependencies) } });

  const signInWith = settings.root ? settings.root.signIn : { providers: [], problems: [] };
  const signInReturn = settings.root ? settings.root.signInReturn : {};
  for (const problem of [...signInWith.problems, ...(signInReturn.problem ? [signInReturn.problem] : [])]) console.warn(`[sign-in] ${problem}`);
  app.use('/api/auth', authRouter({
    db, authService, auth, sessionKey: keys.session, appUrl: APP_URL, accounts: holdsAccounts(role), hub: role.role === 'hub', revocations,
    providers: new SignInProviders({ providers: signInWith.providers, publicUrl: PUBLIC_URL, returnUrl: signInReturn.url, sessionKey: keys.session, accounts: authService }), passwords,
  }));
  if (holdsAccounts(role)) app.use('/api/auth/password', passwordRouter({ passwords, auth, devices, sessionKey: keys.session }));
  const hub = await wireHub({
    dependencies,
    role, mongoUri: settings.mongo.uri, hubDatabase: settings.hubDatabase, ingressDomain: isOff(settings.ingressDomain) ? undefined : settings.ingressDomain, app, tenant, db, mail, publicUrl: PUBLIC_URL, dataKey: keys.data, gitea: giteaService, io,
    hubRepoHook: {
      url: async (projectId) => {
        if (!gitea) throw new Error(`${role.role} keeps no repositories, so no shared project's repository sends it pushes`);
        return hubRepoHookUrl(gitea.reachesKoalaAt, projectId);
      },
      secret: (projectId) => hubRepoHookSecret(typeof keys.data === 'string' ? keys.data : keys.data.current, projectId),
    },
    notify: (ownerId, scope, notice) => notices.post(ownerId, scope, notice),
    republish: () => appExposureService.syncExposedApps(),
    serviceCaller: rootProvider ? (token) => rootProvider.serviceCaller(token) : undefined,
    personAtHub: rootProvider ? (token) => rootProvider.personAtHub(token) : undefined,
    vouch: rootSignIn && role.role === 'hub' ? (req) => rootSignIn.personToken((req as { clientSession?: Parameters<typeof rootSignIn.personToken>[0] }).clientSession) : undefined,
    rootToken,
  });

  tenant.get('/ingress/verify', asyncRoute(async (req, res) => {
    const domain = String(req.query.domain ?? '');
    if (!domain) return res.status(400).send('domain required');
    const deployments = await db.infrastructure.getDeployments();
    const owned = deployments.some((d) => d.isExposedPublicly && d.publicHostname === domain);
    return owned ? res.status(200).send('ok') : res.status(404).send('unknown host');
  }));

  const instancesWiring = await wireInstances({
    role, settings, app, tenant, db, mail, identity, auth, sessionKey: keys.session, publicUrl: PUBLIC_URL,
    repoRoot: path.join(__dirname, '../../..'), dataDir: settings.dataDir, headscale: headscaleService, access: clusterService.access,
    side: instanceSide, syncExposedApps: () => appExposureService.syncExposedApps(), provider: rootProvider, signIn: rootSignIn, rootToken, io,
    instanceArrived,
  });
  late.instances = instancesWiring;
  const people = async () => (await db.accounts.getUsers()).filter((user) => !user.space).map((user) => auth.principalFor(user));
  const { monitoring } = wireMonitoring({ machineStatus: localAgentStatus, tenant, app, operatorOnly: requireOperator('administer'), db, role, poolMonitor: settings.instance?.poolMonitor ?? { off: `${role.role} is not an instance` }, io, clusters: clusterService, proxy: clusterProxyService, notices, notifications, push, mail, people, rootToken });
  const workerService = new WorkerService();
  wireInfrastructure({
    tenant, operatorOnly: requireOperator('administer'), db, io, dataKey: keys.data, sessionKey: keys.session, publicUrl: PUBLIC_URL, appUrl: APP_URL, openRouterUrl: settings.tests.openRouterUrl, googleDrive: settings.operator.googleDrive, repoRoot: path.join(__dirname, '../../..'),
    credentials: credentialService, clusters: clusterService, apps: appService, proxy: clusterProxyService,
    temporalBridge, toolCalling: toolCallParsers, gitea: giteaService, infisical: infisicalService, exposure: appExposureService,
    vpsCatalog: vpsCatalogService, worker: workerService, registry: registryService, gitModules: gitModuleService,
  });

  const getOwnedProject = async (id: string, principal: Principal) => {
    const project = (await db.projects.getProjects()).find((p) => p.id === id);
    return project && authorize(principal, 'see', { kind: 'project', ownerId: project.ownerId }).allowed ? project : undefined;
  };

  const files = instanceFiles ? wireFiles({ tenant, db, files: instanceFiles, projectRepos: projectRepoService, gitea: giteaService, getOwnedProject }) : undefined;
  const releases = wireReleases({
    tenant, db, database: { mongo: settings.mongo, dataKey: keys.data }, io, gitea: giteaService, infisical: infisicalService, clusters: clusterService, projectRepos: projectRepoService, temporalBridge,
    runs: engineRuns, notices, postNotice, secrets: projectSecrets, agents: agentDirectory, registry: engineRegistry,
    exposure: appExposureService, channels, getOwnedProject,
  });
  const { odooReleases, releaseSettings, customizations } = releases;
  wireMachines({
    app, tenant, servesTenants: tenants, accounts: machineAccounts, workTokens,
    instanceCaller,
    db, dataKey: keys.data, publicUrl: PUBLIC_URL, repoRoot: path.join(__dirname, '../../..'), machines: machineService, bundle: machineBundle, projectRepos: projectRepoService,
    ...(tenants ? {
      metricsWrite: async (body: Buffer) => {
        const own = clusterService.ownClusterId();
        if (!own) return { status: 503, text: 'this Koala runs in no cluster of its own to keep metrics on' };
        const base = await clusterProxyService.serviceUrl(own, 'prometheus');
        const answer = await fetch(new URL('api/v1/write', base.endsWith('/') ? base : `${base}/`), {
          method: 'POST', body, headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'snappy', 'x-prometheus-remote-write-version': '0.1.0' },
        });
        return { status: answer.status, text: await answer.text() };
      },
      gateway: {
        port: settings.instance!.gatewayPort,
        host: MACHINE_GATEWAY_HOST,
        upstream: settings.temporal.address,
        namespace: settings.temporal.namespace,
        temporalKey: keys.temporal,
        temporalCa: temporalCa(settings.temporal),
        payloadBlobs: sharedPayloadBlobs(),
      },
    } : {}),
  });
  wireAccounts({ app, role, db, temporal: getTemporalClient, hubPeople: hub.hubPeople, operatorOnly: requireOperator('manage-accounts'), clearSession: auth.clearSession, devices, revocations });
  tenant.use('/api/models', modelsRouter({ modelService, db, credentialService, machines: machineService, rateLimits: getModelRateLimiterSnapshot }));
  tenant.use('/api/tool-call-parsers', toolCallParsersRouter({ parsers: toolCallParsers }));

  const { poisoning, evalHost, level2Service, procedureService, mcpCatalogue } = await wireEngine({
    tenant, db, io, port, registry: tenantServices ? tenantServices.registry : { none: `${role.role} builds no workspace images, so it pushes to no registry` }, webTools: { db, proxy: clusterProxyService, settings: tenantServices?.webTools ?? {}, dependencies }, role, sessionKey: keys.session, dataKey: keys.data, core: engine, temporalBridge, models: modelService, gitea: giteaService, koalasCluster: onKoalasCluster(clusterAccess, koalasCluster), access: clusterAccess,
    ...(instanceFiles ? { files: instanceFiles.fileService, artifacts: instanceFiles.artifacts } : {}), projectRepos: projectRepoService, customizations, releaseSettings, treeModels: () => treeModels, operatorOnly: requireOperator('administer'), push, mail,
  });
  if (evalHost.storyDrops && files) files.setStoryDrops(storyDropsFor({ db, projectRepos: projectRepoService, gitea: giteaService, work: evalHost.storyDrops }));
  if (tenants) void odooReleases.start().then(() => db.accounts.getUsers()).then((users) => odooReleases.recover(users.map((user) => user.id))).catch((err: Error) => console.warn(`[releases] the releases that were running when the backend stopped could not be followed again: ${err.message}`));
  if (tenants) void releases.letReleasesPull().catch((err: Error) => console.warn(`[releases] could not give release namespaces their registry login: ${err.message}`));

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

  if (tenants) {
    setTimeout(() => { void sweepPayloads(); }, PRUNE_FIRST_DELAY_MS).unref();
    setInterval(() => { void sweepPayloads(); }, PRUNE_INTERVAL_MS).unref();
  }

  const { treeModels, groveRuns, groveOrder, planService } = wireProjects({
    tenant, db, io, role, dataKey: keys.data, core, gitea: giteaService, infra: infraService, clusters: clusterService, apps: appService,
    temporalBridge, models: modelService, machines: machineService, registry: engineRegistry, runs: engineRuns, extensions, evalHost,
    workspaceBuilds, workspaceConclusions, workspaceRepos, concluded, sharing: () => hub.sharingService, getOwnedProject,
  });
  const { running } = wireRunning({
    tenant, db, role, temporalBridge, monitoring, workFailures, records: runningRecords, checks: level2Service, trees: groveRuns, runs: engineRuns,
    bench, keeper: memoryKeeper, access: clusterAccess,
    dependencies: { own: () => dependencies.down(), workers: () => db.platform.dependencyStates() },
    signals: { open: (ownerId) => poisoning.list(ownerId, { open: true }) },
  });
  runningNow = async () => {
    const view = await running.view(role.instance?.ownerId ?? '');
    if (!view.ok) return 'unknown';
    return view.value.items.map((item) => item.title);
  };
  if (hub.reaches) {
    if (!files) throw new Error('the hub reaches this backend for its projects\' files, and this backend serves none');
    hub.setWork(hubInstanceWork({
      db, releases: odooReleases, treeRuns: groveRuns, plans: planService, order: groveOrder, accepted: evalHost.acceptedNeeds,
      itemChats, runs: engineRuns, procedures: procedureService, extensions, files: files.fileService, revocations,
    }));
  }

  wireActions({
    tenant, db, role, underTest: settings.underTest, egressKey: keys.egress, temporalBridge, monitoring, releaseSettings,
    treeModels, mcpCatalogue, workspaceDependencies, agentDirectory, agentsHolder, concluded, access: clusterAccess, infisical: infisicalService, clusters: clusterService,
  });

  if (!settings.underTest && gitea && tenants) {
    runOnce(db.platform, 'project-webhooks-reach-koala', new Date().toISOString(), () => projectRepoService.repointWebhooks()).then(
      (result) => { if (result.repointed) console.log(`[webhooks] ${result.repointed} projects' build webhooks now reach ${gitea.reachesKoalaAt}`); },
      (err: Error) => console.warn(`[webhooks] the projects' build webhooks are moved at the next start: ${err.message}`),
    );
  }

  if (!settings.underTest && tenants) {
    runOnce(db.platform, BUILD_TOKENS_MIGRATION, new Date().toISOString(), () => cleanUpBuildTokens({
      deployments: () => db.infrastructure.getDeployments(),
      writePullSecret: pullSecretWriter(clusterAccess, { host: () => giteaService.getRegistryHost(), login: () => giteaService.registryLogin() }),
      runningBuilds: async () => {
        const jobs = JSON.parse(await clusterAccess.kubectl(koalasCluster(), ['get', 'jobs', '-n', 'pipeline-builds', '-o', 'json'])) as { items?: { status?: { active?: number } }[] };
        return (jobs.items ?? []).filter((job) => (job.status?.active ?? 0) > 0).length;
      },
      buildTokens: () => giteaService.buildTokenNames(),
      revoke: (name) => giteaService.revokeToken(name),
    })).then(
      (result) => { if (Object.keys(result).length) console.log(`[tokens] old build tokens: ${Object.entries(result).map(([key, n]) => `${key}=${n}`).join(' ')}`); },
      (err: Error) => console.warn(`[tokens] the old build tokens wait for the next start: ${err.message}`),
    );
    appExposureService.syncExposedApps().catch((e) => {
      const err = e instanceof Error ? e.message : String(e);
      console.error(`[edge] ${err}`);
    });
  }

  if (production) {
    const distPath = path.resolve(__dirname, '../../frontend/dist');
    if (fsSync.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
      console.log(`📦 Serving the frontend from ${distPath}`);
    } else {
      console.warn(`⚠️  NODE_ENV=production but no frontend build at ${distPath} — run \`npm run build\`.`);
    }
  }

  app.use(errorResponder);

  if (!settings.underTest || settings.e2e) {
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${port} is already in use by another process. Run 'npm run clean-dev' or free port ${port}.`);
        process.exit(1);
      }
      console.error(`Provisioning Server Error: ${err.message}`);
      process.exit(1);
    });
    httpServer.listen(port, () => console.log(`🚀 Provisioning Server Active on http://localhost:${port}`));
  }

  void dependencies.start();

  const place = settings.pod;
  const account = settings.clusters.serviceAccount;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void stopBackend({
      stopping: () => { dependencies.stop(); clusterProxyService.stopAll(); },
      drain: { place, ...(account ? { slices: inClusterSlices(account) } : {}), server: httpServer, sockets: io, log: (line) => console.log(line) },
      fences,
      exit: (code) => process.exit(code),
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, io, temporalBridge, db, settings };
}

if (startsHere) {
  bootstrap().catch((err) => {
    if (err instanceof SettingsError) console.error(`[bootstrap] ${err.message}`);
    else console.error('[bootstrap] the backend could not start, so it stops rather than staying up without serving:', err);
    process.exit(1);
  });
}
